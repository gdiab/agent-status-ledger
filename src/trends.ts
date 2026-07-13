import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentReport, Report } from "./types";
import { EXCEPTION_STATUSES } from "./status";
import { plural } from "./render/rollup";

// First cut of cross-day trends (asl-9jn): diff today's report against the
// single most recent prior report on disk. Three annotations only — status
// streaks, per-agent/total commit velocity, recurring error lines. With one
// prior report we can prove exactly a 2-day streak, so the wording claims no
// more than that ("also silent yesterday", never "since Tuesday").

const DAY_MS = 86_400_000;
const REPORT_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/;

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
  if (EXCEPTION_STATUSES.has(today.status) && prev.status === today.status) {
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

  const agents = report.agents.map((a) => {
    const prev = prevById.get(a.profileId);
    const trends = prev ? agentTrends(a, prev, label) : [];
    return trends.length ? { ...a, trends } : a;
  });

  const total = report.agents.reduce((n, a) => n + attributedCount(a), 0);
  const prevTotal = previous.agents.reduce((n, a) => n + attributedCount(a), 0);
  const reportTrends =
    total !== prevTotal ? [`${plural(total, "commit")} vs ${prevTotal} ${label} (${signed(total - prevTotal)})`] : [];

  return {
    ...report,
    agents,
    // Exceptions are by construction agents.filter(EXCEPTION_STATUSES) in the
    // same order (report.ts); rebuilding from the annotated array keeps the
    // objects shared between the two lists without any bookkeeping.
    exceptions: agents.filter((a) => EXCEPTION_STATUSES.has(a.status)),
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
    return isUsablePrior(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// Validates exactly the fields annotateTrends reads off the prior report —
// a truncated or hand-edited history file must degrade to "no trends", never
// crash today's report. windowEnd must be ISO-date-shaped because its date
// slice becomes the trend label and reaches markdown unescaped.
function isUsablePrior(parsed: unknown): parsed is Report {
  if (typeof parsed !== "object" || parsed === null) return false;
  const r = parsed as Report;
  return (
    r.schemaVersion === 1 &&
    typeof r.windowEnd === "string" &&
    /^\d{4}-\d{2}-\d{2}T/.test(r.windowEnd) &&
    Array.isArray(r.agents) &&
    r.agents.every(
      (a) =>
        typeof a === "object" && a !== null &&
        typeof a.profileId === "string" &&
        typeof a.status === "string" &&
        Array.isArray(a.commits) &&
        a.commits.every((c) => typeof c === "object" && c !== null) &&
        Array.isArray(a.facts?.errors),
    )
  );
}
