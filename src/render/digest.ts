import type { AgentReport, Report, TaskThread } from "../types";
import { capSanitizedText } from "../redact";
import { rollupLine, threadRollupSummary } from "./rollup";
import { esc, SEVERITY_COLOR } from "./html";
import { STATUS_SEVERITY } from "../status";

// First sentence of a standup narrative (standup always opens with "I " —
// see src/narrative.ts's Narrative.standup doc). The digest has room for a
// headline, not the full 2-4 sentence paragraph; a multi-sentence standup
// reads fine cut at its first full stop, question, or exclamation.
export function leadSentence(standup: string): string {
  const m = standup.match(/^(.*?[.!?])(\s|$)/);
  return m ? m[1]! : standup;
}

// Section heading shared by the Task threads and Agents headings.
// exceptionsSection keeps its own inline <h2> — its bottom margin differs
// (.5rem inside the triage box) and that section's bytes are pinned by the
// no-threads golden in tests/digest.test.ts.
function h2(text: string): string {
  return `<h2 style="font-size:1rem; margin:0 0 .25rem;">${esc(text)}</h2>`;
}

// Cap for the awaiting-question line below (the digest's policy constant;
// the shared cut lives in src/redact.ts's capSanitizedText). Truncation runs
// on the raw string before esc(), so an HTML entity is never sliced mid-way,
// and the shared truncator's safe-boundary cut never splits a surrogate pair
// (no U+FFFD garbage) or a [REDACTED] marker (no leaked-content noise) —
// the cut backs off to before the atom instead.
export const AWAITING_QUESTION_MAX = 140;

// Each exception row may add AT MOST one line: the awaiting question. This
// is a deliberate narrow carve-out from PRD §13's "no transcript text in the
// digest" rule (decided 2026-07-17, asl-94g) — the field is SanitizedTapeText
// through the sanitizeTapeText choke point (which strips newlines, so the
// line stays single), not raw transcript, and it is truncated to the cap.
function exceptionsSection(report: Report): string {
  const items = report.exceptions.length
    ? report.exceptions
        .map(
          (a) =>
            `<li style="margin:0 0 .4rem;"><strong>${esc(a.displayName)}</strong> — ${esc(a.status)}: ${esc(a.narrative.recommendation)}${a.awaitingQuestion ? `<div style="font-size:.85rem; opacity:.8; margin:.15rem 0 0;">Waiting on: “${esc(capSanitizedText(a.awaitingQuestion, AWAITING_QUESTION_MAX))}”</div>` : ""}</li>`,
        )
        .join("")
    : `<li style="margin:0;">No exceptions — nothing needs you.</li>`;
  return `<div style="border:1px solid #c0392b55; border-radius:8px; padding:.75rem 1rem; margin:0 0 1rem;">
  <h2 style="font-size:1rem; margin:0 0 .5rem;">Exceptions</h2>
  <ul style="margin:0; padding-left:1.1rem;">${items}</ul>
</div>`;
}

// One task-level row: title/key, aggregated status (border severity-colored
// like agent rows), and the shared threadRollupSummary phrase.
function threadRow(t: TaskThread): string {
  return `<tr>
  <td style="padding:.6rem 0; border-top:3px solid ${SEVERITY_COLOR[STATUS_SEVERITY[t.status]]}; border-bottom:1px solid #8884;">
    <div style="font-weight:600;">${esc(t.title)}${t.source === "files" ? ` <span style="font-weight:400; opacity:.7;">(file cluster)</span>` : ""} <span style="font-weight:400; opacity:.7;">— ${esc(t.status)}</span></div>
    <div style="font-size:.85rem; opacity:.7; margin:.15rem 0;">${esc(threadRollupSummary(t))}</div>
  </td>
</tr>`;
}

// Task-thread rollup leading the digest body (PRD §7: the operator's
// question is "how is the task going", not "what did session N do"). Same
// placement the markdown/html reports reconciled in asl-1wm: the exceptions
// triage stays first (PRD §9: "the digest starts with exceptions"), threads
// lead the body ahead of the run-by-run agent rows. Threads arrive
// worst-status-first from deriveTaskThreads (the canonical order for every
// surface), so the exceptions-first posture holds with no local re-sort.
// Absent threads = absent section (and no Agents heading), byte-identical
// output.
function threadsSection(report: Report): string {
  if (!report.threads?.length) return "";
  return `${h2("Task threads")}
<table role="presentation" style="width:100%; border-collapse:collapse; margin:0 0 1rem;">${report.threads.map(threadRow).join("")}</table>
`;
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
  const threads = threadsSection(report);
  const rows = report.agents.length
    ? `<table role="presentation" style="width:100%; border-collapse:collapse; margin:0 0 1rem;">${report.agents.map(agentRow).join("")}</table>`
    : `<p style="opacity:.7;">No agent activity in this window.</p>`;
  // The Agents heading exists only to separate the two tables when a thread
  // rollup precedes the agent rows; without threads the digest keeps its
  // original heading-free shape.
  const body = threads ? `${threads}${h2("Agents")}\n${rows}` : rows;
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Agent Standup — ${esc(day)}</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width:40rem; margin:0 auto; padding:1rem; color:#1a1a1a; line-height:1.4;">
<h1 style="font-size:1.2rem; margin:0 0 .3rem;">Agent Standup — ${esc(day)}</h1>
<p style="margin:0 0 1rem; font-size:.9rem; opacity:.75;">${esc(rollupLine(report))}</p>
${exceptionsSection(report)}
${body}
<p style="font-size:.8rem; opacity:.6; margin-top:1rem;">Full interactive report attached.</p>
</body>
</html>
`;
}
