import type { AgentReport, Report } from "../types";
import { rollupLine } from "./rollup";
import { EVIDENCE_HELP, SEVERITY_HELP, STATUS_HELP } from "./legend";

function agentSection(a: AgentReport): string {
  // The blurb is LLM output: collapse whitespace so it stays one lead line,
  // and escape as plain inline text so LLM output can't inject HTML/links/emphasis.
  const blurb = a.narrative.standup.replace(/\s+/g, " ").trim().replace(/([\\_*<>&[\]()!`])/g, "\\$1");
  const lines = [
    `### ${a.displayName}`,
    "",
    `_${blurb}_`,
    "",
    `- Status: **${a.status}** (${a.severity})`,
    `- Evidence: ${a.evidence}`,
    `- Workdir: \`${a.workdir}\``,
    `- Sessions: ${a.facts.sessionCount} (${a.facts.firstActivity} → ${a.facts.lastActivity})`,
    "",
    `**Worked on:** ${a.narrative.workedOn}`,
    `**Completed:** ${a.narrative.completed}`,
    `**In progress:** ${a.narrative.inProgress}`,
    `**Blocked:** ${a.narrative.blocked}`,
    `**Recommended action:** ${a.narrative.recommendation}`,
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

export function renderMarkdown(report: Report): string {
  const day = report.windowEnd.slice(0, 10);
  const parts = [
    `# Agent Standup — ${day}`,
    "",
    `Window: ${report.windowStart} → ${report.windowEnd}`,
    "",
    rollupLine(report),
    "",
    "## Exceptions",
    "",
  ];
  if (report.exceptions.length === 0) {
    parts.push("No exceptions — nothing needs you.");
  } else {
    for (const a of report.exceptions) {
      parts.push(`- **${a.displayName}** — ${a.status} (${a.severity}): ${a.narrative.recommendation}`);
    }
  }
  parts.push("", "## Agents", "");
  parts.push(report.agents.map(agentSection).join("\n\n---\n\n"));
  parts.push("", "## Legend", "");
  for (const [k, v] of Object.entries(STATUS_HELP)) parts.push(`- **${k}** — ${v}`);
  for (const [k, v] of Object.entries(SEVERITY_HELP)) parts.push(`- **${k}** (severity) — ${v}`);
  for (const [k, v] of Object.entries(EVIDENCE_HELP)) parts.push(`- **${k.replace("_", " ")}** (evidence) — ${v}`);
  if (report.trivialProfiles?.length) {
    const c = report.trivialProfiles.length;
    parts.push("", `_Ignored ${c} trivial profile${c === 1 ? "" : "s"} (minimal activity, nothing produced): ${report.trivialProfiles.join(", ")}_`);
  }
  parts.push("", `_Generated ${report.generatedAt}. Narratives: ${report.agents.every((a) => a.narrativeSource === "template") ? "template" : "llm+template"}._`, "");
  return parts.join("\n");
}
