import type { AgentReport, Report, Severity } from "../types";
import { plural, rollupCounts, rollupLine } from "./rollup";
import { EVIDENCE_HELP, SEVERITY_HELP, STATUS_HELP } from "./legend";
import { STATUS_SEVERITY } from "../status";
import { FILLER_BLOCKED, FILLER_COMPLETED, FILLER_IN_PROGRESS, FILLER_RECOMMENDATION } from "../narrative";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// warning is #8a6d00, not the classic #b8860b: white-on-#b8860b is 3.25:1,
// below AA for badge-size text.
const SEVERITY_COLOR: Record<Severity, string> = { urgent: "#c0392b", warning: "#8a6d00", info: "#2d7a46" };
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

// Stable separator produced by withContext (src/connectors/jsonl.ts) between
// the error reason and its tool/payload context.
const ERROR_CONTEXT_MARKER = " — while ";

// Reason stays the red headline; the tool payload drops to a de-emphasized
// code block. Lines without the marker render whole, as before.
// Basename-first emphasis: the directory prefix is dimmed so the filename
// pops; the full path remains the element's text content.
function fileItem(f: string): string {
  const i = f.lastIndexOf("/");
  if (i === -1) return `<li><code>${esc(f)}</code></li>`;
  return `<li><code><span class="dir">${esc(f.slice(0, i + 1))}</span>${esc(f.slice(i + 1))}</code></li>`;
}

function errorItem(e: string): string {
  const i = e.indexOf(ERROR_CONTEXT_MARKER);
  if (i === -1) return `<li>${esc(e)}</li>`;
  return `<li>${esc(e.slice(0, i))}<code class="error-ctx">${esc(e.slice(i + ERROR_CONTEXT_MARKER.length))}</code></li>`;
}

// Everything below the card header: shared by both layouts.
function cardBody(a: AgentReport): string {
  const commits = a.commits.filter((c) => c.attributed)
    .map((c) => `<li><code>${esc(c.sha.slice(0, 7))}</code> ${esc(c.subject)}</li>`).join("");
  const unattributed = a.commits.filter((c) => !c.attributed)
    .map((c) => `<li><code>${esc(c.sha.slice(0, 7))}</code> ${esc(c.subject)}</li>`).join("");
  const files = a.facts.filesTouched.map(fileItem).join("");
  const errors = a.facts.errors.map(errorItem).join("");
  // A row collapses only when its backing facts are empty AND the narrative
  // is the exact template filler — LLM text is never sniffed, so a model's
  // own phrasing always renders even over empty facts. Each row: label,
  // narrative text, its template filler, and whether facts force it to show.
  const hasCommits = a.facts.commits.length > 0;
  const hasErrors = a.facts.errors.length > 0;
  type Row = readonly [label: string, text: string, filler: string, backed: boolean];
  const mid: Row[] = [
    ["Completed", a.narrative.completed, FILLER_COMPLETED, hasCommits],
    ["In progress", a.narrative.inProgress, FILLER_IN_PROGRESS, false],
    ["Blocked", a.narrative.blocked, FILLER_BLOCKED, hasErrors],
  ];
  const next: Row = ["Next", a.narrative.recommendation, FILLER_RECOMMENDATION, hasCommits || hasErrors];
  const shows = ([, text, filler, backed]: Row) => backed || text !== filler;
  const kept = mid.filter(shows);
  const rows = [
    `<dt>Worked on</dt><dd>${esc(a.narrative.workedOn)}</dd>`,
    ...(kept.length === 0
      ? [`<dd class="filler">Nothing completed, in progress, or blocked.</dd>`]
      : kept.map(([label, text]) => `<dt>${label}</dt><dd>${esc(text)}</dd>`)),
    ...(shows(next) ? [`<dt>Next</dt><dd>${esc(next[1])}</dd>`] : []),
  ];
  return `<dl>
    ${rows.join("\n    ")}
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
  // The name is a styled span with an explicit heading role, not an <h3>:
  // browsers strip heading semantics inside <summary>, and keeping the badges
  // outside the heading element keeps tooltip text out of its accessible name.
  return `<details class="card"${severityEdge(a)}${a.severity === "info" ? "" : " open"}>
  <summary>
    <span class="name" role="heading" aria-level="3">${esc(a.displayName)}</span> ${badges(a)}
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
.cards .name { font-size: 1.1rem; font-weight: 600; }
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
.badge[title], .evidence[title] { text-decoration: underline dotted; text-underline-offset: .15em; cursor: help; }
dl { display: grid; grid-template-columns: 8rem minmax(0, 1fr); gap: .25rem .75rem; margin: .5rem 0; }
dt { font-weight: 600; opacity: .75; } dd { margin: 0; }
.filler { grid-column: 1 / -1; opacity: .5; }
.errors li { color: ${ERROR_RED}; }
.errors li > code { display: block; color: CanvasText; overflow-x: auto; white-space: pre-wrap; font-size: .75rem; opacity: .8; }
code { font-size: .85em; }
.dir { opacity: .6; }
.legend { opacity: .8; font-size: .85rem; margin: 1.5rem 0; }${cardCss}
</style>
</head>
<body>
<h1>Agent Standup — ${esc(day)}</h1>
<p class="window" title="${esc(report.windowStart)} → ${esc(report.windowEnd)}">${esc(fmtUtc(report.windowStart))} → ${esc(fmtUtc(report.windowEnd))} UTC</p>
${rollupChips(report)}
<details class="legend"><summary>Legend</summary>
<h4>Statuses</h4><ul>${(Object.entries(STATUS_HELP)).map(([k, v]) => `<li><strong>${esc(k)}</strong> — ${esc(v)}</li>`).join("")}</ul>
<h4>Severity</h4><ul>${(Object.entries(SEVERITY_HELP)).map(([k, v]) => `<li><strong>${esc(k)}</strong> — ${esc(v)}</li>`).join("")}</ul>
<h4>Evidence</h4><ul>${(Object.entries(EVIDENCE_HELP)).map(([k, v]) => `<li><strong>${esc(k.replace("_", " "))}</strong> — ${esc(v)}</li>`).join("")}</ul>
</details>
<section class="exceptions"><h2>Exceptions</h2><ul>${exceptions}</ul></section>
${agentsSection}
${report.trivialProfiles?.length ? `<p class="window">Ignored ${report.trivialProfiles.length} trivial profile${report.trivialProfiles.length === 1 ? "" : "s"} (minimal activity, nothing produced): ${esc(report.trivialProfiles.join(", "))}</p>` : ""}
<footer class="window" title="${esc(report.generatedAt)}">Generated ${esc(fmtUtc(report.generatedAt))} UTC · schema v${report.schemaVersion}</footer>
</body>
</html>
`;
}
