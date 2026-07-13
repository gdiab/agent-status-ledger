import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentReport, Report, Status } from "./types";

// First cut of cross-day trends (asl-9jn): diff today's report against the
// single most recent prior report on disk. Three annotations only — status
// streaks, per-agent/total commit velocity, recurring error lines. With one
// prior report we can prove exactly a 2-day streak, so the wording claims no
// more than that ("also silent yesterday", never "since Tuesday").

const NOTEWORTHY_STREAK_STATUSES = new Set<Status>(["silent", "blocked", "failed", "needs_human"]);
const DAY_MS = 86_400_000;
const REPORT_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);
const attributedCount = (a: AgentReport) => a.commits.filter((c) => c.attributed).length;

// How to refer to the previous report: "yesterday" only when its window ends
// exactly one calendar day before ours; otherwise the honest dated form
// "on 2026-07-05". Date-only ISO strings parse as UTC, so this cannot drift
// with the generating machine's timezone.
function previousLabel(currentEnd: string, previousEnd: string): string {
  const prevDay = previousEnd.slice(0, 10);
  return Date.parse(currentEnd.slice(0, 10)) - Date.parse(prevDay) === DAY_MS ? "yesterday" : `on ${prevDay}`;
}

function agentTrends(today: AgentReport, prev: AgentReport, label: string): string[] {
  const trends: string[] = [];
  if (NOTEWORTHY_STREAK_STATUSES.has(today.status) && prev.status === today.status) {
    trends.push(`also ${today.status} ${label}`);
  }
  const commits = attributedCount(today);
  const prevCommits = attributedCount(prev);
  if (commits !== prevCommits) {
    trends.push(`${plural(commits, "commit")} vs ${prevCommits} ${label} (${signed(commits - prevCommits)})`);
  }
  const prevErrors = new Set(prev.facts.errors);
  const recurring = today.facts.errors.filter((e) => prevErrors.has(e)).length;
  if (recurring > 0) {
    trends.push(`${plural(recurring, "recurring error")} (also seen ${label})`);
  }
  return trends;
}

// Pure: returns a report with optional trend annotations attached (agents and
// exceptions share the same annotated objects). No previous report — or no
// trends — leaves rendered output byte-identical to the pre-trends pipeline.
export function annotateTrends(report: Report, previous: Report | undefined): Report {
  if (previous === undefined) return report;
  const label = previousLabel(report.windowEnd, previous.windowEnd);
  const prevById = new Map(previous.agents.map((a) => [a.profileId, a]));

  const annotated = new Map<string, AgentReport>(
    report.agents.map((a) => {
      const prev = prevById.get(a.profileId);
      const trends = prev ? agentTrends(a, prev, label) : [];
      return [a.profileId, trends.length ? { ...a, trends } : a];
    }),
  );

  const total = report.agents.reduce((n, a) => n + attributedCount(a), 0);
  const prevTotal = previous.agents.reduce((n, a) => n + attributedCount(a), 0);
  const reportTrends =
    total !== prevTotal ? [`${plural(total, "commit")} vs ${prevTotal} ${label} (${signed(total - prevTotal)})`] : [];

  return {
    ...report,
    agents: report.agents.map((a) => annotated.get(a.profileId) ?? a),
    exceptions: report.exceptions.map((a) => annotated.get(a.profileId) ?? a),
    ...(reportTrends.length ? { trends: reportTrends } : {}),
  };
}

// Most recent report JSON strictly older than currentDay (YYYY-MM-DD), by the
// CLI's `${reportsDir}/${day}.json` naming. History is best-effort context:
// missing dir, no prior file, unparseable JSON, or an unknown schemaVersion
// all yield undefined — never a crash, never a partial read.
export async function loadPreviousReport(reportsDir: string, currentDay: string): Promise<Report | undefined> {
  let names: string[];
  try {
    names = readdirSync(reportsDir);
  } catch {
    return undefined;
  }
  const priorDay = names
    .map((n) => REPORT_FILE.exec(n)?.[1])
    .filter((d): d is string => d !== undefined && d < currentDay)
    .sort()
    .at(-1);
  if (priorDay === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(await Bun.file(join(reportsDir, `${priorDay}.json`)).text());
    if (
      typeof parsed !== "object" || parsed === null ||
      (parsed as Report).schemaVersion !== 1 ||
      !Array.isArray((parsed as Report).agents) ||
      typeof (parsed as Report).windowEnd !== "string"
    ) {
      return undefined;
    }
    return parsed as Report;
  } catch {
    return undefined;
  }
}
