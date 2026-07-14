import type { AgentReport, Report } from "../types";
import { rollupLine } from "./rollup";
import { esc, SEVERITY_COLOR } from "./html";

// First sentence of a standup narrative (standup always opens with "I " —
// see src/narrative.ts's Narrative.standup doc). The digest has room for a
// headline, not the full 2-4 sentence paragraph; a multi-sentence standup
// reads fine cut at its first full stop, question, or exclamation.
export function leadSentence(standup: string): string {
  const m = standup.match(/^(.*?[.!?])(\s|$)/);
  return m ? m[1]! : standup;
}

function exceptionsSection(report: Report): string {
  const items = report.exceptions.length
    ? report.exceptions
        .map(
          (a) =>
            `<li style="margin:0 0 .4rem;"><strong>${esc(a.displayName)}</strong> — ${esc(a.status)}: ${esc(a.narrative.recommendation)}</li>`,
        )
        .join("")
    : `<li style="margin:0;">No exceptions — nothing needs you.</li>`;
  return `<div style="border:1px solid #c0392b55; border-radius:8px; padding:.75rem 1rem; margin:0 0 1rem;">
  <h2 style="font-size:1rem; margin:0 0 .5rem;">Exceptions</h2>
  <ul style="margin:0; padding-left:1.1rem;">${items}</ul>
</div>`;
}

function agentRow(a: AgentReport): string {
  const commits = a.commits.filter((c) => c.attributed).length;
  const files = a.facts.filesTouched.length;
  return `<tr>
  <td style="padding:.6rem 0; border-top:3px solid ${SEVERITY_COLOR[a.severity]}; border-bottom:1px solid #8884;">
    <div style="font-weight:600;">${esc(a.displayName)} <span style="font-weight:400; opacity:.7;">— ${esc(a.status)}</span></div>
    <div style="font-size:.85rem; opacity:.7; margin:.15rem 0;">${commits} commit${commits === 1 ? "" : "s"}, ${files} file${files === 1 ? "" : "s"} touched</div>
    <div style="font-size:.9rem; margin-top:.2rem;">${esc(leadSentence(a.narrative.standup))}</div>
  </td>
</tr>`;
}

// Phone-friendly digest: rollup line, exceptions with one-line context, one
// row per agent. Inline styles only, no <details>, no CSS grid, no
// light-dark() — the interactive report (src/render/html.ts) is attached
// separately for anyone who wants the full view.
export function renderEmailDigest(report: Report): string {
  const day = report.windowEnd.slice(0, 10);
  const rows = report.agents.length
    ? `<table role="presentation" style="width:100%; border-collapse:collapse; margin:0 0 1rem;">${report.agents.map(agentRow).join("")}</table>`
    : `<p style="opacity:.7;">No agent activity in this window.</p>`;
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Agent Standup — ${esc(day)}</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width:40rem; margin:0 auto; padding:1rem; color:#1a1a1a; line-height:1.4;">
<h1 style="font-size:1.2rem; margin:0 0 .3rem;">Agent Standup — ${esc(day)}</h1>
<p style="margin:0 0 1rem; font-size:.9rem; opacity:.75;">${esc(rollupLine(report))}</p>
${exceptionsSection(report)}
${rows}
<p style="font-size:.8rem; opacity:.6; margin-top:1rem;">Full interactive report attached.</p>
</body>
</html>
`;
}
