import type { Config } from "./config";
import type { AgentProfile, AgentReport, CommitEvidence, EvidenceLevel, Report } from "./types";
import { scanClaudeCode } from "./connectors/claude-code";
import { scanCodex } from "./connectors/codex";
import { resolveProfiles } from "./resolver";
import { attributeCommits, listCommits } from "./git";
import { EXCEPTION_STATUSES, inferStatus } from "./status";
import { buildFactSheet, generateNarrative, templateNarrative } from "./narrative";
import { redact, redactFacts } from "./redact";
import { upgradeEvidence, type Exec } from "./connectors/engram";

export interface BuildReportOptions {
  since: Date;
  now: Date;
  config: Config;
  useLlm: boolean;
  apiKey?: string;
  fetchFn?: typeof fetch;
  // Optional exec seam for the Engram evidence-upgrade connector (see
  // src/connectors/engram.ts). Absent = enrichment never runs, matching the
  // connector's own opt-in-only default (config.connectors.engram.enabled).
  engramExec?: Exec;
}

const SEVERITY_ORDER = { urgent: 0, warning: 1, info: 2 } as const;

// Per-profile work (git log + LLM narrative) is independent across profiles;
// run it concurrently, capped so a many-agent morning doesn't burst-hit the
// Anthropic rate limit.
const PROFILE_CONCURRENCY = 4;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]!);
      }
    }),
  );
  return results;
}

// A 12-second accidental session run from ~ shouldn't get a card, let alone
// an urgent exception — but nothing disappears silently: names are reported
// in Report.trivialProfiles and rendered as a footer line. Mid-work sessions
// are never trivial, regardless of span/files/errors/commits: fail toward
// alerting, not toward suppressing a session that's still doing something.
export function isTrivialProfile(profile: AgentProfile, commits: CommitEvidence[], minSessionSeconds: number): boolean {
  return (
    profile.sessions.every(
      (s) =>
        Date.parse(s.lastEventAt) - Date.parse(s.startedAt) < minSessionSeconds * 1000 &&
        s.filesTouched.length === 0 &&
        s.errors.length === 0,
    ) &&
    !commits.some((c) => c.attributed) &&
    !profile.sessions.some((s) => s.midWork)
  );
}

// Optional, fail-soft evidence upgrade: only ever runs for claimed_only
// profiles, only when the engram connector is enabled and an exec seam was
// supplied, and only ever moves evidence up to partially_proven — never
// invents a new status, never touches proven/partially_proven/unknown
// reports. Any failure (missing binary, malformed response, no qualifying
// match, or a thrown error) leaves evidence exactly as inferStatus returned
// it, mirroring sendReportEmail's never-throws contract (asl-533).
//
// Keyed off the profile's harness session UUIDs (RawSession.sessionId),
// which ASL always has — deliberately NOT facts.filesTouched, which under
// inferStatus's formula is guaranteed empty exactly when evidence is
// claimed_only (that's what claimed_only means: no observed file activity).
//
// Query budget: each session tried costs 1 grep + up to 3 peek subprocesses
// (MAX_GREP_CANDIDATES in connectors/engram.ts), all sequential and
// blocking, so a many-session profile must not fan out unbounded. Callers
// pass sessionIds newest-first (recent sessions are the ones most likely to
// be in the engram index and most relevant to today's report) and only the
// first MAX_ENGRAM_SESSIONS are tried — worst case 5 × (1 + 3) = 20
// subprocess calls per claimed_only profile, ~60ms each observed.
const MAX_ENGRAM_SESSIONS = 5;

export async function applyEngramEnrichment(
  evidence: EvidenceLevel,
  sessionIds: string[],
  engramConfig: Config["connectors"]["engram"],
  exec: Exec | undefined,
): Promise<{ evidence: EvidenceLevel; evidenceCitation?: string }> {
  if (evidence !== "claimed_only" || !engramConfig.enabled || !exec) return { evidence };
  try {
    for (const sessionId of sessionIds.slice(0, MAX_ENGRAM_SESSIONS)) {
      const result = await upgradeEvidence(sessionId, engramConfig.binaryPath, exec);
      if (result.matched) return { evidence: "partially_proven", evidenceCitation: result.citation };
    }
  } catch {
    // fail-soft: engram enrichment must never break report generation
  }
  return { evidence };
}

export async function buildReport(opts: BuildReportOptions): Promise<Report> {
  const { since, now, config } = opts;
  const sessions = [
    ...(config.connectors.claudeCode.enabled
      ? await scanClaudeCode({ since, now, rootDir: config.connectors.claudeCode.rootDir, redactPatterns: config.redactPatterns })
      : []),
    ...(config.connectors.codex.enabled
      ? await scanCodex({ since, now, rootDir: config.connectors.codex.rootDir, redactPatterns: config.redactPatterns })
      : []),
  ];
  const profiles = resolveProfiles(sessions);

  type ProfileResult = { agent: AgentReport } | { trivial: string };

  const results = await mapLimit<AgentProfile, ProfileResult>(profiles, PROFILE_CONCURRENCY, async (profile) => {
    const rawCommits = attributeCommits(await listCommits(profile.workdir, since), profile.sessions);
    if (isTrivialProfile(profile, rawCommits, config.thresholds.minSessionSeconds)) {
      return { trivial: profile.displayName };
    }
    // Defense in depth: redact commit subjects here at the model layer too, so any
    // future consumer of buildReport() (not just the CLI's own render pass) gets a
    // report object with secrets already scrubbed.
    const commits = rawCommits.map((c) => ({ ...c, subject: redact(c.subject, config.redactPatterns) }));
    const { status, severity, evidence: inferredEvidence } = inferStatus(profile, rawCommits, now, config.thresholds);
    const facts = redactFacts(buildFactSheet(profile, commits), config.redactPatterns);
    // Newest session first (explicit sort rather than trusting the profile's
    // ascending order) — see applyEngramEnrichment's budget comment.
    const sessionIdsNewestFirst = [...profile.sessions]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((s) => s.sessionId);
    const { evidence, evidenceCitation } = await applyEngramEnrichment(
      inferredEvidence, sessionIdsNewestFirst, config.connectors.engram, opts.engramExec,
    );
    const { narrative, source } = opts.useLlm
      ? await generateNarrative(facts, status, { model: config.model, apiKey: opts.apiKey, fetchFn: opts.fetchFn })
      : { narrative: templateNarrative(facts, status), source: "template" as const };
    return {
      agent: {
        profileId: profile.profileId,
        displayName: profile.displayName,
        platform: profile.platform,
        workdir: profile.workdir,
        status, severity, evidence, evidenceCitation,
        facts,
        narrative,
        narrativeSource: source,
        commits,
      },
    };
  });

  const agents = results.flatMap((r) => ("agent" in r ? [r.agent] : []));
  const trivialProfiles = results.flatMap((r) => ("trivial" in r ? [r.trivial] : [])).sort();

  agents.sort((a, b) =>
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.displayName.localeCompare(b.displayName));

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    windowStart: since.toISOString(),
    windowEnd: now.toISOString(),
    exceptions: agents.filter((a) => EXCEPTION_STATUSES.has(a.status)),
    agents,
    ...(trivialProfiles.length ? { trivialProfiles } : {}),
  };
}
