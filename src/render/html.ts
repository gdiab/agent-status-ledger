import type { AgentReport, Report } from "../types";
import { rollupLine } from "./rollup";
import { EVIDENCE_HELP, SEVERITY_HELP, STATUS_HELP } from "./legend";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const SEVERITY_COLOR: Record<string, string> = { urgent: "#c0392b", warning: "#b8860b", info: "#2d7a46" };

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

function flatCard(a: AgentReport): string {
  return `<article class="card">
  <header>
    <h3>${esc(a.displayName)}</h3>
    ${badges(a)}
  </header>
  ${cardBody(a)}
</article>`;
}

function standupCard(a: AgentReport): string {
  return `<details class="card">
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
  const agentCards = layout === "cards"
    ? `<div class="cards">${report.agents.map(standupCard).join("\n")}</div>`
    : report.agents.map(flatCard).join("\n");
  const agentsSection = `<section><h2>All agents</h2>${agentCards}</section>`;
  const cardCss = layout === "cards" ? `
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(20rem, 1fr)); gap: 1rem; align-items: start; }
.cards .card { margin: 0; }
details.card > summary { cursor: pointer; list-style: none; }
details.card > summary::-webkit-details-marker { display: none; }
details.card .standup { display: block; font-style: italic; margin-top: .5rem; }
details.card .detail { margin-top: .75rem; border-top: 1px solid #8884; padding-top: .5rem; }` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Standup — ${esc(day)}</title>
<style>
:root { color-scheme: light dark; font-family: -apple-system, system-ui, sans-serif; }
body { max-width: 60rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
h1 { font-size: 1.5rem; } h3 { margin: 0; font-size: 1.1rem; }
.window { opacity: .7; font-size: .85rem; }
.exceptions { border: 1px solid #c0392b55; border-radius: 8px; padding: 1rem 1.5rem; margin: 1rem 0; }
.card { border: 1px solid #8884; border-radius: 8px; padding: 1rem 1.25rem; margin: 1rem 0; }
.card header { display: flex; gap: .6rem; align-items: center; margin-bottom: .5rem; }
.badge { color: #fff; border-radius: 999px; padding: .1rem .6rem; font-size: .75rem; }
.evidence { opacity: .6; font-size: .75rem; }
dl { display: grid; grid-template-columns: 8rem 1fr; gap: .25rem .75rem; margin: .5rem 0; }
dt { font-weight: 600; opacity: .75; } dd { margin: 0; }
.errors li { color: #c0392b; }
code { font-size: .85em; }
.legend { opacity: .8; font-size: .85rem; margin: 1.5rem 0; }${cardCss}
</style>
</head>
<body>
<h1>Agent Standup — ${esc(day)}</h1>
<p class="window">${esc(report.windowStart)} → ${esc(report.windowEnd)}</p>
<p class="rollup">${esc(rollupLine(report))}</p>
<section class="exceptions"><h2>Exceptions</h2><ul>${exceptions}</ul></section>
${agentsSection}
<details class="legend"><summary>Legend</summary>
<h4>Statuses</h4><ul>${(Object.entries(STATUS_HELP)).map(([k, v]) => `<li><strong>${esc(k)}</strong> — ${esc(v)}</li>`).join("")}</ul>
<h4>Severity</h4><ul>${(Object.entries(SEVERITY_HELP)).map(([k, v]) => `<li><strong>${esc(k)}</strong> — ${esc(v)}</li>`).join("")}</ul>
<h4>Evidence</h4><ul>${(Object.entries(EVIDENCE_HELP)).map(([k, v]) => `<li><strong>${esc(k.replace("_", " "))}</strong> — ${esc(v)}</li>`).join("")}</ul>
</details>
${report.trivialProfiles?.length ? `<p class="window">Ignored ${report.trivialProfiles.length} trivial profile${report.trivialProfiles.length === 1 ? "" : "s"} (minimal activity, nothing produced): ${esc(report.trivialProfiles.join(", "))}</p>` : ""}
<footer class="window">Generated ${esc(report.generatedAt)} · schema v${report.schemaVersion}</footer>
</body>
</html>
`;
}
