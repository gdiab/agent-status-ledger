import type { AgentReport, Report } from "../types";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const SEVERITY_COLOR: Record<string, string> = { urgent: "#c0392b", warning: "#b8860b", info: "#2d7a46" };

function card(a: AgentReport): string {
  const commits = a.commits.filter((c) => c.attributed)
    .map((c) => `<li><code>${esc(c.sha.slice(0, 7))}</code> ${esc(c.subject)}</li>`).join("");
  const files = a.facts.filesTouched.map((f) => `<li><code>${esc(f)}</code></li>`).join("");
  const errors = a.facts.errors.map((e) => `<li>${esc(e)}</li>`).join("");
  return `<article class="card">
  <header>
    <h3>${esc(a.displayName)}</h3>
    <span class="badge" style="background:${SEVERITY_COLOR[a.severity]}">${esc(a.status)}</span>
    <span class="evidence">${esc(a.evidence.replace("_", " "))}</span>
  </header>
  <dl>
    <dt>Worked on</dt><dd>${esc(a.narrative.workedOn)}</dd>
    <dt>Completed</dt><dd>${esc(a.narrative.completed)}</dd>
    <dt>In progress</dt><dd>${esc(a.narrative.inProgress)}</dd>
    <dt>Blocked</dt><dd>${esc(a.narrative.blocked)}</dd>
    <dt>Next</dt><dd>${esc(a.narrative.recommendation)}</dd>
  </dl>
  ${commits ? `<h4>Commits</h4><ul>${commits}</ul>` : ""}
  ${files ? `<details><summary>Files touched (${a.facts.filesTouched.length})</summary><ul>${files}</ul></details>` : ""}
  ${errors ? `<h4>Errors</h4><ul class="errors">${errors}</ul>` : ""}
</article>`;
}

export function renderHtml(report: Report): string {
  const day = report.windowEnd.slice(0, 10);
  const exceptions = report.exceptions.length
    ? report.exceptions.map((a) =>
        `<li><strong>${esc(a.displayName)}</strong> — ${esc(a.status)}: ${esc(a.narrative.recommendation)}</li>`).join("")
    : "<li>No exceptions — nothing needs you.</li>";
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
</style>
</head>
<body>
<h1>Agent Standup — ${esc(day)}</h1>
<p class="window">${esc(report.windowStart)} → ${esc(report.windowEnd)}</p>
<section class="exceptions"><h2>Exceptions</h2><ul>${exceptions}</ul></section>
<section><h2>All agents</h2>${report.agents.map(card).join("\n")}</section>
<footer class="window">Generated ${esc(report.generatedAt)} · schema v${report.schemaVersion}</footer>
</body>
</html>
`;
}
