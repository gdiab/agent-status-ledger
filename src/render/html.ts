import type { AgentReport, Report } from "../types";
import { plural, rollupCounts, rollupLine } from "./rollup";
import { EVIDENCE_HELP, SEVERITY_HELP, STATUS_HELP } from "./legend";
import { STATUS_SEVERITY } from "../status";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// warning is #8a6d00, not the classic #b8860b: white-on-#b8860b is 3.25:1,
// below AA for badge-size text.
const SEVERITY_COLOR: Record<string, string> = { urgent: "#c0392b", warning: "#8a6d00", info: "#2d7a46" };
// #c0392b on the dark canvas is 3.20:1; the page opts into color-scheme
// light dark, so error red must adapt per scheme.
const ERROR_RED = "light-dark(#c0392b, #e07b6c)";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Human-readable timestamp, always UTC: rendered output must not depend on
// the generating machine's timezone. Callers keep the full ISO in a title.
function fmtUtc(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export const HTML_LAYOUTS = ["cards", "flat"] as const;
export type HtmlLayout = (typeof HTML_LAYOUTS)[number];

function badges(a: AgentReport): string {
  return `<span class="badge" style="background:${SEVERITY_COLOR[a.severity]}" title="${esc(STATUS_HELP[a.status])}">${esc(a.status)}</span>
    <span class="evidence" title="${esc(EVIDENCE_HELP[a.evidence])}">${esc(a.evidence.replace("_", " "))}</span>`;
}

// Everything below the card header: shared by both layouts.
function cardBody(a: AgentReport): string {
  const commits = a.commits.filter((c) => c.attributed)
    .map((c) => `<li><code>${esc(c.sha.slice(0, 7))}</code> ${esc(c.subject)}</li>`).join("");
  const unattributed = a.commits.filter((c) => !c.attributed)
    .map((c) => `<li><code>${esc(c.sha.slice(0, 7))}</code> ${esc(c.subject)}</li>`).join("");
  const files = a.facts.filesTouched.map((f) => `<li><code>${esc(f)}</code></li>`).join("");
  const errors = a.facts.errors.map((e) => `<li>${esc(e)}</li>`).join("");
  return `<dl>
    <dt>Worked on</dt><dd>${esc(a.narrative.workedOn)}</dd>
    <dt>Completed</dt><dd>${esc(a.narrative.completed)}</dd>
    <dt>In progress</dt><dd>${esc(a.narrative.inProgress)}</dd>
    <dt>Blocked</dt><dd>${esc(a.narrative.blocked)}</dd>
    <dt>Next</dt><dd>${esc(a.narrative.recommendation)}</dd>
  </dl>
  ${commits ? `<h4>Commits</h4><ul>${commits}</ul>` : ""}
  ${unattributed ? `<details><summary>Other repo commits (not attributed to this agent)</summary><ul>${unattributed}</ul></details>` : ""}
  ${files ? `<details><summary>Files touched (${a.facts.filesTouched.length})</summary><ul>${files}</ul></details>` : ""}
  ${errors ? `<h4>Errors</h4><ul class="errors">${errors}</ul>` : ""}`;
}

// A 3px severity-colored left edge on every card: scannable "who needs me"
// signal without reading each badge. Inline style, same mechanism as badges.
function severityEdge(a: AgentReport): string {
  return ` style="border-left: 3px solid ${SEVERITY_COLOR[a.severity]}"`;
}

function flatCard(a: AgentReport): string {
  return `<article class="card"${severityEdge(a)}>
  <header>
    <h3>${esc(a.displayName)}</h3>
    ${badges(a)}
  </header>
  ${cardBody(a)}
</article>`;
}

// Counts-by-status as small badge-styled chips: always-visible legend, and
// the eye can match chip color to card badges without reading.
function rollupChips(report: Report): string {
  if (report.agents.length === 0) return `<p class="rollup">${esc(rollupLine(report))}</p>`;
  const c = rollupCounts(report);
  const chips = c.byStatus.map(({ status, count }) =>
    `<span class="badge" style="background:${SEVERITY_COLOR[STATUS_SEVERITY[status]]}" title="${esc(STATUS_HELP[status])}">${count} ${esc(status)}</span>`).join(" ");
  return `<p class="rollup">${plural(c.agents, "agent")}: ${chips} · ${plural(c.commits, "commit")}, ${plural(c.files, "file")} touched</p>`;
}

function standupCard(a: AgentReport): string {
  // Exception-severity detail must be visible without interaction (and in
  // print), so warning/urgent cards start open.
  return `<details class="card"${severityEdge(a)}${a.severity === "info" ? "" : " open"}>
  <summary>
    <h3>${esc(a.displayName)} ${badges(a)}</h3>
    <span class="standup">${esc(a.narrative.standup)}</span>
  </summary>
  <div class="detail">
  ${cardBody(a)}
  </div>
</details>`;
}

export function renderHtml(report: Report, opts: { layout?: HtmlLayout } = {}): string {
  const layout = opts.layout ?? "cards";
  const day = report.windowEnd.slice(0, 10);
  const exceptions = report.exceptions.length
    ? report.exceptions.map((a) =>
        `<li><strong>${esc(a.displayName)}</strong> — ${esc(a.status)}: ${esc(a.narrative.recommendation)}</li>`).join("")
    : "<li>No exceptions — nothing needs you.</li>";
  // Agents are already sorted exceptions-first; labeled sections make the
  // split explicit, but only when both kinds exist — a homogeneous morning
  // needs no triage headers.
  const grid = (agents: AgentReport[]) => `<div class="cards">${agents.map(standupCard).join("\n")}</div>`;
  const attention = report.agents.filter((a) => a.severity !== "info");
  const fyi = report.agents.filter((a) => a.severity === "info");
  const agentCards = layout === "cards"
    ? (attention.length && fyi.length
        ? `<h3 class="group">Needs attention</h3>${grid(attention)}<h3 class="group">FYI</h3>${grid(fyi)}`
        : grid(report.agents))
    : report.agents.map(flatCard).join("\n");
  const agentsSection = `<section><h2>All agents</h2>${agentCards}</section>`;
  const cardCss = layout === "cards" ? `
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(20rem, 1fr)); gap: 1rem; align-items: start; }
.group { font-size: .85rem; text-transform: uppercase; letter-spacing: .05em; opacity: .7; margin: 1.25rem 0 .5rem; }
.cards .card { margin: 0; }
.cards dl { grid-template-columns: 6rem minmax(0, 1fr); }
.cards dt { font-size: .8rem; text-transform: uppercase; letter-spacing: .03em; }
details.card > summary { cursor: pointer; list-style: none; position: relative; padding-right: 1.5rem; }
details.card > summary:hover { background: #8881; }
details.card > summary::after { content: "▸"; position: absolute; right: 0; top: 0; opacity: .5; }
details.card[open] > summary::after { content: "▾"; }
details.card > summary::-webkit-details-marker { display: none; }
details.card .standup { display: block; margin-top: .5rem; border-left: 2px solid #8884; padding-left: .6rem; opacity: .85; }
details.card .detail { margin-top: .75rem; border-top: 1px solid #8884; padding-top: .5rem; }` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Standup — ${esc(day)}</title>
<style>
:root { color-scheme: light dark; font-family: -apple-system, system-ui, sans-serif; }
body { max-width: 80rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
h1 { font-size: 1.5rem; } h3 { margin: 0; font-size: 1.1rem; }
.window { opacity: .7; font-size: .85rem; }
.exceptions { border: 1px solid light-dark(#c0392b55, #e07b6c55); border-radius: 8px; padding: 1rem 1.5rem; margin: 1rem 0; overflow-wrap: anywhere; }
.card { border: 1px solid #8884; border-radius: 8px; padding: 1rem 1.25rem; margin: 1rem 0; overflow-wrap: anywhere; }
.card header { display: flex; flex-wrap: wrap; gap: .6rem; row-gap: .25rem; align-items: center; margin-bottom: .5rem; }
.badge { color: #fff; border-radius: 999px; padding: .1rem .6rem; font-size: .75rem; }
.evidence { opacity: .6; font-size: .75rem; }
dl { display: grid; grid-template-columns: 8rem minmax(0, 1fr); gap: .25rem .75rem; margin: .5rem 0; }
dt { font-weight: 600; opacity: .75; } dd { margin: 0; }
.errors li { color: ${ERROR_RED}; }
code { font-size: .85em; }
.legend { opacity: .8; font-size: .85rem; margin: 1.5rem 0; }${cardCss}
</style>
</head>
<body>
<h1>Agent Standup — ${esc(day)}</h1>
<p class="window" title="${esc(report.windowStart)} → ${esc(report.windowEnd)}">${esc(fmtUtc(report.windowStart))} → ${esc(fmtUtc(report.windowEnd))} UTC</p>
${rollupChips(report)}
<section class="exceptions"><h2>Exceptions</h2><ul>${exceptions}</ul></section>
${agentsSection}
<details class="legend"><summary>Legend</summary>
<h4>Statuses</h4><ul>${(Object.entries(STATUS_HELP)).map(([k, v]) => `<li><strong>${esc(k)}</strong> — ${esc(v)}</li>`).join("")}</ul>
<h4>Severity</h4><ul>${(Object.entries(SEVERITY_HELP)).map(([k, v]) => `<li><strong>${esc(k)}</strong> — ${esc(v)}</li>`).join("")}</ul>
<h4>Evidence</h4><ul>${(Object.entries(EVIDENCE_HELP)).map(([k, v]) => `<li><strong>${esc(k.replace("_", " "))}</strong> — ${esc(v)}</li>`).join("")}</ul>
</details>
${report.trivialProfiles?.length ? `<p class="window">Ignored ${report.trivialProfiles.length} trivial profile${report.trivialProfiles.length === 1 ? "" : "s"} (minimal activity, nothing produced): ${esc(report.trivialProfiles.join(", "))}</p>` : ""}
<footer class="window" title="${esc(report.generatedAt)}">Generated ${esc(fmtUtc(report.generatedAt))} UTC · schema v${report.schemaVersion}</footer>
</body>
</html>
`;
}
