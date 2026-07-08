import type { Config } from "./config";
import type { AgentReport, Report } from "./types";
import { scanClaudeCode } from "./connectors/claude-code";
import { scanCodex } from "./connectors/codex";
import { resolveProfiles } from "./resolver";
import { attributeCommits, listCommits } from "./git";
import { inferStatus } from "./status";
import { buildFactSheet, generateNarrative, templateNarrative } from "./narrative";
import { redactFacts } from "./redact";

export interface BuildReportOptions {
  since: Date;
  now: Date;
  config: Config;
  useLlm: boolean;
  apiKey?: string;
  fetchFn?: typeof fetch;
}

const SEVERITY_ORDER = { urgent: 0, warning: 1, info: 2 } as const;
const EXCEPTION_STATUSES = new Set(["blocked", "failed", "silent", "needs_human"]);

export async function buildReport(opts: BuildReportOptions): Promise<Report> {
  const { since, now, config } = opts;
  const sessions = [
    ...(config.connectors.claudeCode.enabled
      ? await scanClaudeCode({ since, now, rootDir: config.connectors.claudeCode.rootDir })
      : []),
    ...(config.connectors.codex.enabled
      ? await scanCodex({ since, now, rootDir: config.connectors.codex.rootDir })
      : []),
  ];
  const profiles = resolveProfiles(sessions);

  const agents: AgentReport[] = [];
  for (const profile of profiles) {
    const commits = attributeCommits(await listCommits(profile.workdir, since), profile.sessions);
    const { status, severity, evidence } = inferStatus(profile, commits, now, config.thresholds);
    const facts = redactFacts(buildFactSheet(profile, commits), config.redactPatterns);
    const { narrative, source } = opts.useLlm
      ? await generateNarrative(facts, status, { model: config.model, apiKey: opts.apiKey, fetchFn: opts.fetchFn })
      : { narrative: templateNarrative(facts, status), source: "template" as const };
    agents.push({
      profileId: profile.profileId,
      displayName: profile.displayName,
      platform: profile.platform,
      workdir: profile.workdir,
      status, severity, evidence,
      facts,
      narrative,
      narrativeSource: source,
      commits,
    });
  }

  agents.sort((a, b) =>
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.displayName.localeCompare(b.displayName));

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    windowStart: since.toISOString(),
    windowEnd: now.toISOString(),
    exceptions: agents.filter((a) => EXCEPTION_STATUSES.has(a.status)),
    agents,
  };
}
