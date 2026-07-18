import type { AgentReport, Report, Severity, Status, TaskThread } from "../types";
import { dispatchRefLabel, dispatchedBody, interactionLabel, plural, rollupCounts, rollupLine, threadSessionSummary } from "./rollup";
import { EVIDENCE_HELP, SEVERITY_HELP, STATUS_HELP } from "./legend";
import { STATUS_SEVERITY } from "../status";
import { FILLER_BLOCKED, FILLER_COMPLETED, FILLER_IN_PROGRESS, FILLER_RECOMMENDATION } from "../narrative";
import { COLORS_HEX, FONT_MONO, FONT_SANS, LEADING, RADIUS, SPACING, STATUS_COLORS, TEXT_SCALE, TRACKING, WEIGHT, type ColorRole } from "./theme";

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Digest-only legacy palette (asl-ec7): the HTML report now styles by status
// via theme.ts, but digest.ts still inlines these hexes and its golden is
// byte-pinned, so the values must not change until the digest slice re-pins.
// warning is #8a6d00, not the classic #b8860b: white-on-#b8860b is 3.25:1,
// below AA for badge-size text.
export const SEVERITY_COLOR: Record<Severity, string> = { urgent: "#c0392b", warning: "#8a6d00", info: "#2d7a46" };

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
export function isHtmlLayout(x: string): x is HtmlLayout {
  return (HTML_LAYOUTS as readonly string[]).includes(x);
}

// Severity → CSS class on card/thread containers; urgent containers get the
// full danger-subtle background tint (asl-ec7 §8 Q6) and the class stays a
// stable hook for tests and future styling. Badges color by *status* instead
// (stClass below) so e.g. active reads as live and completed as success.
function sevClass(severity: Severity): string {
  return `sev-${severity}`;
}

// Status → CSS class driving the Futurist dot+word badge colors.
function stClass(status: Status): string {
  return `st-${status}`;
}

// ── Generated CSS: Futurist tokens as custom properties (asl-ec7 slice B) ──
// theme.ts is the single source (Token Contract Rule, DESIGN.md §2): every
// color below is emitted from COLORS_HEX, light values on :root and dark
// under prefers-color-scheme — the report stays a single self-contained file
// (the system's [data-theme] switch doesn't apply to a static artifact).

function colorTokenCss(scheme: "light" | "dark"): string {
  return Object.entries(COLORS_HEX).map(([token, pair]) => `${token}: ${pair[scheme]};`).join(" ");
}

const SCALAR_TOKEN_CSS = Object.entries({
  "--font-sans": FONT_SANS,
  "--font-mono": FONT_MONO,
  ...TEXT_SCALE,
  ...SPACING,
  ...RADIUS,
  ...WEIGHT,
  ...LEADING,
  ...TRACKING,
}).map(([token, v]) => `${token}: ${v};`).join(" ");

// Badge var() names per color role — the var-name twin of theme.ts's
// STATUS_COLORS resolution (which carries hexes for email surfaces): semantic
// roles use their `-subtle` pair with the solid hue as dot; the two special
// roles mirror theme.ts's composed() choices.
function roleBadgeVars(role: ColorRole): { bg: string; fg: string; dot: string } {
  switch (role) {
    // One Signal Rule (DESIGN.md §2): live state is the Signal Green dot
    // only — the word stays body ink, never a green filled badge. Transparent
    // bg (not --bg-1): "a small colored dot plus a word, not a filled pill".
    case "accent":
      return { bg: "transparent", fg: "var(--fg-2)", dot: "var(--accent)" };
    case "neutral":
      return { bg: "var(--bg-3)", fg: "var(--fg-2)", dot: "var(--fg-3)" };
    default:
      return { bg: `var(--${role}-subtle)`, fg: `var(--${role}-subtle-fg)`, dot: `var(--${role})` };
  }
}

// Dot geometry: the 7px hollow ring optically matches the 5px filled dot —
// a stroked circle reads smaller than a filled one at equal diameter.
const DOT_SIZE = "5px";
const HOLLOW_DOT_SIZE = "7px";
const HOLLOW_DOT_RING = "1.5px";

// One .st-* rule per status, generated from STATUS_COLORS so the Record<Status, …>
// exhaustiveness check covers the CSS too. Hollow dots (silent: absence of
// signal, §8 Q2) ring the hue instead of filling it.
const STATUS_CSS = (Object.entries(STATUS_COLORS) as [Status, (typeof STATUS_COLORS)[Status]][])
  .flatMap(([status, c]) => {
    const v = roleBadgeVars(c.role);
    const rules = [`.${stClass(status)} { background: ${v.bg}; color: ${v.fg}; --dot: ${v.dot}; }`];
    if (c.dot === "hollow") {
      rules.push(`.${stClass(status)} .dot { width: ${HOLLOW_DOT_SIZE}; height: ${HOLLOW_DOT_SIZE}; background: transparent; border: ${HOLLOW_DOT_RING} solid var(--dot); }`);
    }
    return rules;
  }).join("\n");

// Defensive front-of-card cap: the standup blurb is length-limited prompt-side
// (~400 chars), but a pathological or non-LLM blurb could still blow out the
// card layout, so truncate before escaping.
const STANDUP_MAX = 280;
function capStandup(s: string): string {
  return s.length > STANDUP_MAX ? s.slice(0, STANDUP_MAX).trimEnd() + "…" : s;
}

// Futurist badge: a small colored dot plus a word (DESIGN.md §5), colored by
// status. The dot is presentational; the word carries the meaning.
function statusBadge(status: Status, label: string): string {
  return `<span class="badge ${stClass(status)}" title="${esc(STATUS_HELP[status])}"><span class="dot" aria-hidden="true"></span>${esc(label)}</span>`;
}

function badges(a: AgentReport): string {
  return `${statusBadge(a.status, a.status)}
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
  // Both dispatch kinds — cross-session links as named refs, in-session
  // subagent runs as a count — plus truncation phrasing live in
  // dispatchedBody; only the escaping is renderer-side.
  const dispatched = dispatchedBody(
    (a.dispatched ?? []).map(dispatchRefLabel),
    a.dispatchedRuns ?? 0,
    a.dispatchTruncated ?? false,
  );
  const rows = [
    `<dt>Worked on</dt><dd>${esc(a.narrative.workedOn)}</dd>`,
    ...(kept.length === 0
      ? [`<dd class="filler">Nothing completed, in progress, or blocked.</dd>`]
      : kept.map(([label, text]) => `<dt>${label}</dt><dd>${esc(text)}</dd>`)),
    ...(shows(next) ? [`<dt>Next</dt><dd>${esc(next[1])}</dd>`] : []),
    // Cross-day trend annotations (src/trends.ts); absent = no history, no row.
    ...(a.trends?.length ? [`<dt>Trend</dt><dd>${esc(a.trends.join("; "))}</dd>`] : []),
    // Engram dispatch-marker lineage; absent = no row. Plain <dl> rows like
    // Trend above, so both card layouts' grid rules apply untouched; the
    // .dispatch class marks the cells for styling and testability.
    ...(a.dispatchedBy?.length
      ? [`<dt>Dispatched by</dt><dd class="dispatch">${esc(a.dispatchedBy.map(dispatchRefLabel).join(", "))}</dd>`]
      : []),
    ...(dispatched ? [`<dt>Dispatched</dt><dd class="dispatch">${esc(dispatched)}</dd>`] : []),
    // Corroboration from an enrichment connector (engram); absent = no row.
    // Distinct class: "evidence" is the badge span on every card, so the
    // citation needs its own marker for styling and testability.
    ...(a.evidenceCitation ? [`<dt>Evidence</dt><dd class="evidence-citation">${esc(a.evidenceCitation)}</dd>`] : []),
    // Conversation-signal classification (asl-cey); absent = no row.
    ...(a.interactionKind
      ? [`<dt>Session kind</dt><dd class="interaction-kind">${esc(interactionLabel(a.interactionKind))}</dd>`]
      : []),
    // The decision an awaiting-user run is waiting on, quoted from the
    // agent's final message (sanitized at the engram parse boundary; esc is
    // renderer-side defense in depth, asl-xis).
    ...(a.awaitingQuestion
      ? [`<dt>Waiting on</dt><dd class="awaiting-question">“${esc(a.awaitingQuestion)}”</dd>`]
      : []),
  ];
  return `<dl>
    ${rows.join("\n    ")}
  </dl>
  ${commits ? `<h4>Commits</h4><ul>${commits}</ul>` : ""}
  ${unattributed ? `<details><summary>Other repo commits (not attributed to this agent)</summary><ul>${unattributed}</ul></details>` : ""}
  ${files ? `<details><summary>Files touched (${a.facts.filesTouched.length})</summary><ul>${files}</ul></details>` : ""}
  ${errors ? `<h4>Errors</h4><ul class="errors">${errors}</ul>` : ""}`;
}

// One task thread (src/threads.ts): title, status badge (severity-colored
// like card badges), evidence label, then one line per member run with its
// evidence counts. Session refs reuse dispatchRefLabel so threads and
// dispatch lineage name runs identically; timestamps follow the window's
// fmtUtc convention with the full ISO in a title.
function threadBlock(t: TaskThread): string {
  const runs = t.sessions.map((s) =>
    `<li title="${esc(s.startedAt)}"><span class="ts">${esc(fmtUtc(s.startedAt))}</span> — ${esc(dispatchRefLabel({ sessionId: s.sessionId, profile: s.profile }))}: ${esc(threadSessionSummary(s))}</li>`,
  ).join("");
  return `<div class="thread ${sevClass(STATUS_SEVERITY[t.status])}">
  <h3>${esc(t.title)}${t.source === "files" ? ` <span class="thread-source">(file cluster)</span>` : ""}
    ${statusBadge(t.status, t.status)}
    <span class="evidence" title="${esc(EVIDENCE_HELP[t.evidence])}">${esc(t.evidence.replace("_", " "))}</span>
  </h3>
  <ul>${runs}</ul>
</div>`;
}

function threadsSection(report: Report): string {
  if (!report.threads?.length) return "";
  return `<section class="threads"><h2>Task threads</h2>
${report.threads.map(threadBlock).join("\n")}
</section>
`;
}

function flatCard(a: AgentReport): string {
  return `<article class="card ${sevClass(a.severity)}">
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
  const chips = c.byStatus.map(({ status, count }) => statusBadge(status, `${count} ${status}`)).join(" ");
  return `<p class="rollup">${plural(c.agents, "agent")}: ${chips} · ${plural(c.commits, "commit")}, ${plural(c.files, "file")} touched</p>`;
}

function standupCard(a: AgentReport): string {
  // Exception-severity detail must be visible without interaction (and in
  // print), so warning/urgent cards start open.
  // The name is a styled span with an explicit heading role, not an <h3>:
  // browsers strip heading semantics inside <summary>, and keeping the badges
  // outside the heading element keeps tooltip text out of its accessible name.
  return `<details class="card ${sevClass(a.severity)}"${a.severity === "info" ? "" : " open"}>
  <summary>
    <span class="name" role="heading" aria-level="3">${esc(a.displayName)}</span> ${badges(a)}
    <span class="standup">${esc(capStandup(a.narrative.standup))}</span>
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
        // Awaiting question quoted like the card row (line 138), sharing its
        // awaiting-question class: the triage li names the decision being
        // waited on, not just the recommendation.
        `<li><strong>${esc(a.displayName)}</strong> — ${esc(a.status)}: ${esc(a.narrative.recommendation)}${a.awaitingQuestion ? ` — Waiting on: <span class="awaiting-question">“${esc(a.awaitingQuestion)}”</span>` : ""}</li>`).join("")
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
.group { color: var(--fg-3); margin: 1.25rem 0 .5rem; }
.group::before { content: "// "; }
.cards .card { margin: 0; }
.cards .name { font-size: 1.1rem; font-weight: var(--weight-semibold); color: var(--fg-1); }
.cards dl { grid-template-columns: 6rem minmax(0, 1fr); }
details.card > summary { cursor: pointer; list-style: none; position: relative; padding-right: 1.5rem; border-radius: var(--radius-md); }
details.card > summary:hover { background: var(--bg-2); }
details.card > summary::after { content: "▸"; position: absolute; right: 0; top: 0; color: var(--fg-4); }
details.card[open] > summary::after { content: "▾"; }
details.card > summary::-webkit-details-marker { display: none; }
details.card .standup { display: block; margin-top: .5rem; background: var(--bg-2); border-radius: var(--radius-md); padding: .45rem .6rem; color: var(--fg-2); }
details.card .detail { margin-top: .75rem; border-top: 1px solid var(--border-1); padding-top: .5rem; }` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Standup — ${esc(day)}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible+Next:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');
:root { color-scheme: light dark; ${SCALAR_TOKEN_CSS} }
:root { ${colorTokenCss("light")} }
@media (prefers-color-scheme: dark) {
:root { ${colorTokenCss("dark")} }
}
body { max-width: var(--max-content); margin: 2rem auto; padding: 0 var(--gutter); background: var(--bg-0); color: var(--fg-2); font-family: var(--font-sans); font-size: var(--text-base); line-height: var(--leading-normal); }
h1 { font-size: var(--text-2xl); line-height: var(--leading-tight); font-weight: var(--weight-semibold); letter-spacing: var(--tracking-tight); color: var(--fg-1); }
h2 { font-size: var(--text-lg); line-height: var(--leading-snug); font-weight: var(--weight-semibold); letter-spacing: var(--tracking-tight); color: var(--fg-1); }
h3 { margin: 0; font-size: 1.1rem; color: var(--fg-1); }
h4 { margin: .75rem 0 .25rem; font-size: var(--text-sm); color: var(--fg-1); }
:focus-visible { outline: 3px solid var(--accent-ring); outline-offset: 1px; border-radius: var(--radius-sm); }
.window { color: var(--fg-3); font-size: var(--text-xs); font-family: var(--font-mono); }
.exceptions { background: var(--danger-subtle); border: 1px solid var(--border-1); border-radius: var(--radius-lg); padding: var(--card-pad); margin: 1rem 0; overflow-wrap: anywhere; }
/* Mono eyebrow: the one caps-label idiom shared by section labels and dl terms. */
.group, .exceptions h2, dt { font-family: var(--font-mono); font-size: var(--text-2xs); font-weight: var(--weight-medium); letter-spacing: var(--tracking-caps); text-transform: uppercase; }
.exceptions h2 { margin: 0 0 .5rem; color: var(--danger-subtle-fg); }
.exceptions h2::before { content: "// "; }
.card { background: var(--bg-1); border: 1px solid var(--border-1); border-radius: var(--radius-lg); padding: var(--card-pad); margin: 1rem 0; overflow-wrap: anywhere; }
.card.sev-urgent, .thread.sev-urgent { background: var(--danger-subtle); }
.card header { display: flex; flex-wrap: wrap; gap: .6rem; row-gap: .25rem; align-items: center; margin-bottom: .5rem; }
.badge { display: inline-flex; align-items: center; gap: .4em; min-height: 18px; padding: 0 7px; border-radius: var(--radius-sm); font-family: var(--font-mono); font-size: var(--text-2xs); font-weight: var(--weight-medium); letter-spacing: 0.03em; line-height: 1; }
.badge .dot { flex: none; width: ${DOT_SIZE}; height: ${DOT_SIZE}; border-radius: 50%; background: var(--dot); }
${STATUS_CSS}
.evidence { color: var(--fg-3); font-family: var(--font-mono); font-size: var(--text-2xs); }
.badge[title], .evidence[title] { text-decoration: underline dotted; text-underline-offset: .15em; cursor: help; }
dl { display: grid; grid-template-columns: 8rem minmax(0, 1fr); gap: .25rem .75rem; margin: .5rem 0; }
dt { color: var(--fg-3); padding-top: .2em; } dd { margin: 0; }
.filler { grid-column: 1 / -1; color: var(--fg-3); }
.errors li { color: var(--danger-subtle-fg); }
.errors li > code { display: block; color: var(--fg-3); overflow-x: auto; white-space: pre-wrap; font-size: var(--text-xs); }
code { font-family: var(--font-mono); font-size: .92em; }
.dir { color: var(--fg-4); }
.legend { color: var(--fg-3); font-size: var(--text-sm); margin: 1.5rem 0; }
.ts { font-family: var(--font-mono); }
.thread { background: var(--bg-1); border: 1px solid var(--border-1); border-radius: var(--radius-lg); padding: .75rem var(--card-pad); margin: 1rem 0; overflow-wrap: anywhere; }
.thread.sev-urgent { background: var(--danger-subtle); }
.thread h3 { display: flex; flex-wrap: wrap; gap: .6rem; row-gap: .25rem; align-items: center; }
.thread ul { margin: .5rem 0 0; }
.thread-source { color: var(--fg-3); font-size: var(--text-xs); font-weight: var(--weight-regular); }${cardCss}
</style>
</head>
<body>
<h1>Agent Standup — ${esc(day)}</h1>
<p class="window" title="${esc(report.windowStart)} → ${esc(report.windowEnd)}">${esc(fmtUtc(report.windowStart))} → ${esc(fmtUtc(report.windowEnd))} UTC</p>
${rollupChips(report)}
${report.trends?.length ? `<p class="window">Trends: ${esc(report.trends.join("; "))}</p>\n` : ""}<details class="legend"><summary>Legend</summary>
<h4>Statuses</h4><ul>${(Object.entries(STATUS_HELP)).map(([k, v]) => `<li><strong>${esc(k)}</strong> — ${esc(v)}</li>`).join("")}</ul>
<h4>Severity</h4><ul>${(Object.entries(SEVERITY_HELP)).map(([k, v]) => `<li><strong>${esc(k)}</strong> — ${esc(v)}</li>`).join("")}</ul>
<h4>Evidence</h4><ul>${(Object.entries(EVIDENCE_HELP)).map(([k, v]) => `<li><strong>${esc(k.replace("_", " "))}</strong> — ${esc(v)}</li>`).join("")}</ul>
</details>
<section class="exceptions"><h2>Exceptions</h2><ul>${exceptions}</ul></section>
${threadsSection(report)}${agentsSection}
${report.trivialProfiles?.length ? `<p class="window">Ignored ${report.trivialProfiles.length} trivial profile${report.trivialProfiles.length === 1 ? "" : "s"} (minimal activity, nothing produced): ${esc(report.trivialProfiles.join(", "))}</p>` : ""}
<footer class="window" title="${esc(report.generatedAt)}">Generated ${esc(fmtUtc(report.generatedAt))} UTC · schema v${report.schemaVersion}</footer>
</body>
</html>
`;
}
