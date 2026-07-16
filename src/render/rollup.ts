import type { DispatchRef, Report, Status } from "../types";

// Exhaustive by construction: adding a Status member without a display rank
// is a compile error, so new statuses can't silently vanish from the rollup.
// Exported: TaskThread derivation (src/threads.ts) rolls member statuses up
// exceptions-first with the same worst-first ordering, defined once.
export const STATUS_RANK: Record<Status, number> = {
  failed: 0, silent: 1, blocked: 2, needs_human: 3, active: 4, idle: 5, completed: 6,
};
const STATUS_ORDER = (Object.keys(STATUS_RANK) as Status[]).sort((a, b) => STATUS_RANK[a] - STATUS_RANK[b]);

export interface RollupCounts {
  agents: number;
  byStatus: { status: Status; count: number }[]; // worst-first, zero statuses omitted
  commits: number;
  files: number;
}

export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

// Counts only — renderers own presentation (markdown prose, HTML chips).
export function rollupCounts(report: Report): RollupCounts {
  const counts = new Map<Status, number>();
  let commits = 0;
  const files = new Set<string>();
  for (const a of report.agents) {
    counts.set(a.status, (counts.get(a.status) ?? 0) + 1);
    commits += a.commits.filter((c) => c.attributed).length;
    for (const f of a.facts.filesTouched) files.add(f);
  }
  return {
    agents: report.agents.length,
    byStatus: STATUS_ORDER.filter((s) => counts.has(s)).map((s) => ({ status: s, count: counts.get(s)! })),
    commits,
    files: files.size,
  };
}

// "3 blocked, 1 silent" — worst-first, shared by the markdown rollup line
// and the email subject so they never drift apart.
export function statusSummary(report: Report): string {
  return rollupCounts(report)
    .byStatus.map(({ status, count }) => `${count} ${status}`)
    .join(", ");
}

// Plain-text label for one end of a dispatch-marker link, shared by the
// markdown and html renderers so the phrasing never drifts apart. Escaping
// stays renderer-side (mdEscape / esc) — this is content assembly only. The
// session id is shape-validated by the connector (hex and dashes), so an
// 8-char prefix is unambiguous enough for a report line and never noisy.
export function dispatchRefLabel(ref: DispatchRef): string {
  const sid = `session ${ref.sessionId.slice(0, 8)}`;
  return ref.profile ? `${ref.profile} (${sid})` : sid;
}

// Body of the "Dispatched" line, shared by the markdown and html renderers
// so the phrasing never drifts apart: cross-session links arrive as
// pre-escaped labels (escaping stays renderer-side); in-session subagent
// runs (AgentReport.dispatchedRuns) have no session of their own to name,
// so they contribute a count. truncated: the lineage probe hit its
// marker-tape cap, so the discovered lineage may be an undercount — say so
// instead of implying completeness. A truncated probe that found NOTHING
// still gets a body: silence would be indistinguishable from an exhaustive
// "no dispatches". undefined = nothing dispatched and nothing hidden, no line.
export function dispatchedBody(labels: string[], runs: number, truncated: boolean): string | undefined {
  const total = labels.length + runs;
  if (total === 0) return truncated ? "subagent runs: none identified (list may be incomplete)" : undefined;
  const parts = [...labels, ...(runs ? [plural(runs, "in-session run")] : [])];
  return `${plural(total, "subagent run")}: ${parts.join(", ")}${truncated ? " (list may be incomplete)" : ""}`;
}

export function rollupLine(report: Report): string {
  if (report.agents.length === 0) return "No agent activity in this window.";
  const c = rollupCounts(report);
  return `${plural(c.agents, "agent")}: ${statusSummary(report)} — ${plural(c.commits, "commit")}, ${plural(c.files, "file")} touched`;
}
