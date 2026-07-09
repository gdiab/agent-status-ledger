import type { Report, Status } from "../types";

const STATUS_ORDER: Status[] = ["failed", "silent", "blocked", "needs_human", "active", "idle", "completed"];

export function rollupLine(report: Report): string {
  const counts = new Map<Status, number>();
  let commits = 0;
  let files = 0;
  for (const a of report.agents) {
    counts.set(a.status, (counts.get(a.status) ?? 0) + 1);
    commits += a.commits.filter((c) => c.attributed).length;
    files += a.facts.filesTouched.length;
  }
  const n = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  const byStatus = STATUS_ORDER.filter((s) => counts.has(s))
    .map((s) => `${counts.get(s)} ${s}`)
    .join(", ");
  return `${n(report.agents.length, "agent")}: ${byStatus} — ${n(commits, "commit")}, ${n(files, "file")} touched`;
}
