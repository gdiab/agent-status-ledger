import type { AgentReport, Report, TaskThread } from "../types";
import { dispatchRefLabel, dispatchedBody, plural, rollupLine, threadSessionSummary } from "./rollup";
import { EVIDENCE_HELP, SEVERITY_HELP, STATUS_HELP } from "./legend";

// Names come from workdir basenames and platform labels; escape markdown
// emphasis/link/code chars so a name like my_project or a`b can't open a
// formatting span. Narrower than the blurb escaper below by design: names are
// filesystem-derived, not LLM output, and md injection is accepted for v0.
const mdEscape = (s: string) => s.replace(/([\\_*[\]`])/g, "\\$1");

// Escaper for LLM-generated narrative text (standup blurb + the five narrative
// fields): collapse whitespace so multi-line LLM output stays one line, then
// escape markdown emphasis/link/code/HTML chars so it can't inject formatting.
const mdText = (s: string) => s.replace(/\s+/g, " ").trim().replace(/([\\_*<>&[\]()!`])/g, "\\$1");

function agentSection(a: AgentReport): string {
  const blurb = mdText(a.narrative.standup);
  // Both dispatch kinds — cross-session links as named refs, in-session
  // subagent runs as a count — plus truncation phrasing live in
  // dispatchedBody; only the escaping is renderer-side.
  const dispatched = dispatchedBody(
    (a.dispatched ?? []).map((r) => mdEscape(dispatchRefLabel(r))),
    a.dispatchedRuns ?? 0,
    a.dispatchTruncated ?? false,
  );
  const lines = [
    `### ${mdEscape(a.displayName)}`,
    "",
    `_${blurb}_`,
    "",
    `- Status: **${a.status}** (${a.severity})`,
    `- Evidence: ${a.evidence}`,
    // Corroboration from an enrichment connector (engram); absent = no line.
    // Assembled from session ids and file paths — mdEscape so an underscore
    // or bracket in a path can't open a formatting span (asl-xis).
    ...(a.evidenceCitation ? [`- Evidence citation: ${mdEscape(a.evidenceCitation)}`] : []),
    `- Workdir: \`${a.workdir}\``,
    `- Sessions: ${a.facts.sessionCount} (${a.facts.firstActivity} → ${a.facts.lastActivity})`,
    // Cross-day trend annotations (src/trends.ts); absent = no history, no line.
    ...(a.trends?.length ? [`- Trend: ${a.trends.join("; ")}`] : []),
    // Engram dispatch-marker lineage; absent = no line. Profile names are
    // workdir-basename-derived like displayName, so mdEscape applies; session
    // ids are connector-validated hex/dash and pass through unchanged.
    ...(a.dispatchedBy?.length
      ? [`- Dispatched by: ${a.dispatchedBy.map((r) => mdEscape(dispatchRefLabel(r))).join(", ")}`]
      : []),
    ...(dispatched ? [`- Dispatched ${dispatched}`] : []),
    "",
    `**Worked on:** ${mdText(a.narrative.workedOn)}`,
    `**Completed:** ${mdText(a.narrative.completed)}`,
    `**In progress:** ${mdText(a.narrative.inProgress)}`,
    `**Blocked:** ${mdText(a.narrative.blocked)}`,
    `**Recommended action:** ${mdText(a.narrative.recommendation)}`,
  ];
  if (a.commits.some((c) => c.attributed)) {
    lines.push("", "**Commits:**");
    for (const c of a.commits.filter((c) => c.attributed)) lines.push(`- \`${c.sha.slice(0, 7)}\` ${c.subject}`);
  }
  // Capped: in a busy shared repo this list is context, not the headline.
  const unattributed = a.commits.filter((c) => !c.attributed);
  if (unattributed.length) {
    lines.push("", "**Other repo commits (not attributed to this agent):**");
    for (const c of unattributed.slice(0, 5)) lines.push(`- \`${c.sha.slice(0, 7)}\` ${c.subject}`);
    if (unattributed.length > 5) lines.push(`- …and ${unattributed.length - 5} more`);
  }
  if (a.facts.filesTouched.length) {
    lines.push("", "**Files touched:**");
    for (const f of a.facts.filesTouched) lines.push(`- \`${f}\``);
  }
  if (a.facts.errors.length) {
    lines.push("", "**Errors:**");
    for (const e of a.facts.errors) lines.push(`- ${e}`);
  }
  return lines.join("\n");
}

// One task thread (src/threads.ts): heading is the key/title (a
// shape-validated bead ID, or redacted shared-file basenames — mdEscape
// either way), then one line per member run with its evidence counts.
// Session refs reuse dispatchRefLabel so threads and dispatch lineage name
// runs identically.
function threadSection(t: TaskThread): string {
  const lines = [
    `### ${mdEscape(t.title)}${t.source === "files" ? " (file cluster)" : ""} — ${t.status}, ${plural(t.sessions.length, "session")}`,
  ];
  for (const s of t.sessions) {
    lines.push(`- ${s.startedAt} — ${mdEscape(dispatchRefLabel({ sessionId: s.sessionId, profile: s.profile }))}: ${threadSessionSummary(s)}`);
  }
  return lines.join("\n");
}

export function renderMarkdown(report: Report): string {
  const day = report.windowEnd.slice(0, 10);
  const parts = [
    `# Agent Standup — ${day}`,
    "",
    `Window: ${report.windowStart} → ${report.windowEnd}`,
    "",
    rollupLine(report),
    "",
    ...(report.trends?.length ? [`Trends: ${report.trends.join("; ")}`, ""] : []),
    "## Exceptions",
    "",
  ];
  if (report.exceptions.length === 0) {
    parts.push("No exceptions — nothing needs you.");
  } else {
    for (const a of report.exceptions) {
      parts.push(`- **${mdEscape(a.displayName)}** — ${a.status} (${a.severity}): ${mdText(a.narrative.recommendation)}`);
    }
  }
  // Task threads sit between the exceptions triage and the per-agent cards:
  // the operator's question is "how is the task going", answered before the
  // run-by-run detail. Absent threads = absent section, byte-identical output.
  if (report.threads?.length) {
    parts.push("", "## Task threads", "");
    parts.push(report.threads.map(threadSection).join("\n\n"));
  }
  parts.push("", "## Agents", "");
  parts.push(report.agents.map(agentSection).join("\n\n---\n\n"));
  parts.push("", "## Legend", "");
  for (const [k, v] of Object.entries(STATUS_HELP)) parts.push(`- **${k}** — ${v}`);
  for (const [k, v] of Object.entries(SEVERITY_HELP)) parts.push(`- **${k}** (severity) — ${v}`);
  for (const [k, v] of Object.entries(EVIDENCE_HELP)) parts.push(`- **${k.replace("_", " ")}** (evidence) — ${v}`);
  if (report.trivialProfiles?.length) {
    const c = report.trivialProfiles.length;
    parts.push("", `_Ignored ${c} trivial profile${c === 1 ? "" : "s"} (minimal activity, nothing produced): ${report.trivialProfiles.map(mdEscape).join(", ")}_`);
  }
  parts.push("", `_Generated ${report.generatedAt}. Narratives: ${report.agents.every((a) => a.narrativeSource === "template") ? "template" : "llm+template"}._`, "");
  return parts.join("\n");
}
