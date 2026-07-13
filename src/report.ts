import type { Config } from "./config";
import type { AgentProfile, AgentReport, CommitEvidence, Report } from "./types";
import { scanClaudeCode } from "./connectors/claude-code";
import { scanCodex } from "./connectors/codex";
import { resolveProfiles } from "./resolver";
import { attributeCommits, listCommits } from "./git";
import { EXCEPTION_STATUSES, inferStatus } from "./status";
import { buildFactSheet, generateNarrative, templateNarrative } from "./narrative";
import { redact, redactFacts } from "./redact";

export interface BuildReportOptions {
  since: Date;
  now: Date;
  config: Config;
  useLlm: boolean;
  apiKey?: string;
  fetchFn?: typeof fetch;
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
    const { status, severity, evidence } = inferStatus(profile, rawCommits, now, config.thresholds);
    const facts = redactFacts(buildFactSheet(profile, commits), config.redactPatterns);
    const { narrative, source } = opts.useLlm
      ? await generateNarrative(facts, status, { model: config.model, apiKey: opts.apiKey, fetchFn: opts.fetchFn })
      : { narrative: templateNarrative(facts, status), source: "template" as const };
    return {
      agent: {
        profileId: profile.profileId,
        displayName: profile.displayName,
        platform: profile.platform,
        workdir: profile.workdir,
        status, severity, evidence,
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
