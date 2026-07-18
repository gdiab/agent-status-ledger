import type { AgentReport, Report, Status, TaskThread } from "../types";
import { capSanitizedText } from "../redact";
import { rollupLine, threadRollupSummary } from "./rollup";
import { esc } from "./html";
import { COLORS_HEX, STATUS_COLORS, statusHex } from "./theme";

// ── Futurist tokens resolved to light-theme hex literals (asl-ec7 slice C) ──
// Gmail strips <style>, so no CSS custom properties: theme.ts tokens are
// resolved to hex at render time. Light only (§8 Q8) — Gmail's auto-darkening
// is accepted; the inks below sit mid-lightness and survive it.
const FG_1 = COLORS_HEX["--fg-1"].light; // body ink
const FG_3 = COLORS_HEX["--fg-3"].light; // muted/meta — replaces opacity-based muting
const BORDER_1 = COLORS_HEX["--border-1"].light; // hairline
const DANGER_SUBTLE = COLORS_HEX["--danger-subtle"].light; // exceptions tint

// Web fonts need a stylesheet, so the email declares installed-font stacks
// only: Atkinson Hyperlegible Next leads and degrades to system (§4).
const FONT_BODY = "'Atkinson Hyperlegible Next', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
// Mono Numbers Rule (DESIGN.md §3): numeric spans in mono.
const FONT_MONO = "ui-monospace, 'SF Mono', Menlo, monospace";

// Status as a leading dot + word (DESIGN.md §5: "a small colored dot plus a
// word, not a filled pill") — the inline replacement for the banned
// border-top severity stripes (§4/§8 Q5). No CSS circles in email: the dot is
// a text glyph, colored by the status's dot token. silent's hollow ring (§8
// Q2, absence of signal) approximates as ○ — a glyph renders where a
// border-radius span might not.
function statusWord(status: Status): string {
  const c = STATUS_COLORS[status];
  const glyph = c.dot === "hollow" ? "○" : "●";
  return `<span style="font-weight:400; color:${FG_3};">— <span style="color:${statusHex(c).dot};">${glyph}</span> ${esc(status)}</span>`;
}

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
// (8px inside the triage box) and that section's bytes are pinned by the
// no-threads golden in tests/digest.test.ts.
function h2(text: string): string {
  return `<h2 style="font-size:14px; margin:0 0 4px; color:${FG_1};">${esc(text)}</h2>`;
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
// The box carries the danger-subtle background tint (system precedent for
// alerts) instead of the old translucent red border.
function exceptionsSection(report: Report): string {
  const items = report.exceptions.length
    ? report.exceptions
        .map(
          (a) =>
            `<li style="margin:0 0 8px;"><strong>${esc(a.displayName)}</strong> — ${esc(a.status)}: ${esc(a.narrative.recommendation)}${a.awaitingQuestion ? `<div style="font-size:12px; color:${FG_3}; margin:2px 0 0;">Waiting on: “${esc(capSanitizedText(a.awaitingQuestion, AWAITING_QUESTION_MAX))}”</div>` : ""}</li>`,
        )
        .join("")
    : `<li style="margin:0;">No exceptions — nothing needs you.</li>`;
  return `<div style="background:${DANGER_SUBTLE}; border:1px solid ${BORDER_1}; border-radius:8px; padding:12px 16px; margin:0 0 16px;">
  <h2 style="font-size:14px; margin:0 0 8px; color:${FG_1};">Exceptions</h2>
  <ul style="margin:0; padding-left:16px;">${items}</ul>
</div>`;
}

// One task-level row: title/key, aggregated status as dot+word, and the
// shared threadRollupSummary phrase (numeric, so mono).
function threadRow(t: TaskThread): string {
  return `<tr>
  <td style="padding:8px 0; border-bottom:1px solid ${BORDER_1};">
    <div style="font-weight:600; color:${FG_1};">${esc(t.title)}${t.source === "files" ? ` <span style="font-weight:400; color:${FG_3};">(file cluster)</span>` : ""} ${statusWord(t.status)}</div>
    <div style="font-size:12px; color:${FG_3}; font-family:${FONT_MONO}; margin:2px 0;">${esc(threadRollupSummary(t))}</div>
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
<table role="presentation" style="width:100%; border-collapse:collapse; margin:0 0 16px;">${report.threads.map(threadRow).join("")}</table>
`;
}

function agentRow(a: AgentReport): string {
  const commits = a.commits.filter((c) => c.attributed).length;
  const files = a.facts.filesTouched.length;
  return `<tr>
  <td style="padding:8px 0; border-bottom:1px solid ${BORDER_1};">
    <div style="font-weight:600; color:${FG_1};">${esc(a.displayName)} ${statusWord(a.status)}</div>
    <div style="font-size:12px; color:${FG_3}; font-family:${FONT_MONO}; margin:2px 0;">${commits} commit${commits === 1 ? "" : "s"}, ${files} file${files === 1 ? "" : "s"} touched</div>
    <div style="margin-top:4px;">${esc(leadSentence(a.narrative.standup))}</div>
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
    ? `<table role="presentation" style="width:100%; border-collapse:collapse; margin:0 0 16px;">${report.agents.map(agentRow).join("")}</table>`
    : `<p style="color:${FG_3};">No agent activity in this window.</p>`;
  // The Agents heading exists only to separate the two tables when a thread
  // rollup precedes the agent rows; without threads the digest keeps its
  // original heading-free shape.
  const body = threads ? `${threads}${h2("Agents")}\n${rows}` : rows;
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Agent Standup — ${esc(day)}</title></head>
<body style="font-family:${FONT_BODY}; max-width:40rem; margin:0 auto; padding:16px; color:${FG_1}; font-size:14px; line-height:1.5;">
<h1 style="font-size:17px; font-weight:600; letter-spacing:-0.011em; margin:0 0 4px; color:${FG_1};">Agent Standup — ${esc(day)}</h1>
<p style="margin:0 0 16px; font-size:12px; color:${FG_3}; font-family:${FONT_MONO};">${esc(rollupLine(report))}</p>
${exceptionsSection(report)}
${body}
<p style="font-size:12px; color:${FG_3}; margin-top:16px;">Full interactive report attached.</p>
</body>
</html>
`;
}
