import type { Report, Status } from "../types";

// Exhaustive by construction: adding a Status member without a display rank
// is a compile error, so new statuses can't silently vanish from the rollup.
const STATUS_RANK: Record<Status, number> = {
  failed: 0, silent: 1, blocked: 2, needs_human: 3, active: 4, idle: 5, completed: 6,
};
const STATUS_ORDER = (Object.keys(STATUS_RANK) as Status[]).sort((a, b) => STATUS_RANK[a] - STATUS_RANK[b]);

export function rollupLine(report: Report): string {
  if (report.agents.length === 0) return "No agent activity in this window.";
  const counts = new Map<Status, number>();
  let commits = 0;
  const files = new Set<string>();
  for (const a of report.agents) {
    counts.set(a.status, (counts.get(a.status) ?? 0) + 1);
    commits += a.commits.filter((c) => c.attributed).length;
    for (const f of a.facts.filesTouched) files.add(f);
  }
  const n = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  const byStatus = STATUS_ORDER.filter((s) => counts.has(s))
    .map((s) => `${counts.get(s)} ${s}`)
    .join(", ");
  return `${n(report.agents.length, "agent")}: ${byStatus} — ${n(commits, "commit")}, ${n(files.size, "file")} touched`;
}
