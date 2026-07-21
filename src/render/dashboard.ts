// Dashboard presentation for `asl serve` (asl-eia): the injected header-bar
// chrome and the standalone archive/empty/not-found pages. Routes and run
// state live in src/server.ts; nothing here touches the filesystem.
import { esc } from "./esc";
import { FONT_MONO, hexLightDark as ld, RADIUS, SPACING, TEXT_SCALE, TRACKING } from "./theme";

// All chrome color/type values resolve through theme.ts (asl-2h8's rule):
// the dashboard must not be born with hand-rolled hex drift.
const DASHBOARD_CSS = `
#asl-dash-bar { position: sticky; top: 0; z-index: 9999; display: flex; align-items: center;
  gap: ${SPACING["--space-4"]}; padding: ${SPACING["--space-2"]} ${SPACING["--space-4"]};
  font-family: ${FONT_MONO}; font-size: ${TEXT_SCALE["--text-2xs"]};
  letter-spacing: ${TRACKING["--tracking-caps"]}; text-transform: uppercase;
  background: ${ld("--bg-1")}; color: ${ld("--fg-2")};
  border-bottom: 1px solid ${ld("--border-1")}; }
#asl-dash-bar a { color: inherit; }
#asl-dash-bar .spacer { flex: 1; }
#asl-dash-bar button { font: inherit; letter-spacing: inherit; text-transform: inherit;
  cursor: pointer; padding: ${SPACING["--space-1"]} ${SPACING["--space-2"]};
  border-radius: ${RADIUS["--radius-sm"]}; border: 1px solid ${ld("--border-2")};
  background: ${ld("--bg-2")}; color: inherit; }
#asl-dash-bar button:disabled { cursor: default; color: ${ld("--fg-4")}; }
#asl-dash-status.err { color: ${ld("--danger-subtle-fg")}; }
`;

// Poll /api/status after a refresh; reload on success so the rewritten
// report file is what's on screen. A failed poll fetch retries on the same
// cadence instead of killing the loop.
const DASHBOARD_JS = `
const btn = document.getElementById("asl-dash-refresh");
const st = document.getElementById("asl-dash-status");
async function aslPoll() {
  let s;
  try { s = await (await fetch("/api/status")).json(); }
  catch { setTimeout(aslPoll, 2000); return; }
  if (s.running) { setTimeout(aslPoll, 2000); return; }
  if (s.lastExit && !s.lastExit.ok) { st.textContent = "last refresh failed"; st.className = "err"; btn.disabled = false; return; }
  location.reload();
}
btn.addEventListener("click", async () => {
  btn.disabled = true; st.textContent = "refreshing\\u2026"; st.className = "";
  const r = await fetch("/api/refresh", { method: "POST" });
  if (r.status === 202 || r.status === 409) aslPoll();
  else { st.textContent = "refresh error"; st.className = "err"; btn.disabled = false; }
});
`;

function dashBar(ctx: { date: string; dates: string[] }): string {
  const i = ctx.dates.indexOf(ctx.date);
  const newer = i > 0 ? ctx.dates[i - 1] : undefined;
  const older = i >= 0 && i < ctx.dates.length - 1 ? ctx.dates[i + 1] : undefined;
  return (
    `<div id="asl-dash-bar"><span>${esc(ctx.date)}</span>` +
    (older ? `<a href="/r/${esc(older)}">&larr; ${esc(older)}</a>` : "") +
    (newer ? `<a href="/r/${esc(newer)}">${esc(newer)} &rarr;</a>` : "") +
    `<a href="/archive">archive</a><span class="spacer"></span>` +
    `<span id="asl-dash-status"></span><button id="asl-dash-refresh">refresh</button></div>`
  );
}

// Stored report files stay pristine; chrome is injected into the response
// only. String surgery, not a parser: reports are our own renderer's output,
// and the no-body fallback keeps arbitrary html serveable.
export function wrapReport(reportHtml: string, ctx: { date: string; dates: string[] }): string {
  const style = `<style>${DASHBOARD_CSS}</style>`;
  const script = `<script>${DASHBOARD_JS}</script>`;
  if (/<body[^>]*>/i.test(reportHtml)) {
    // Replacer functions, not replacement strings: injected chrome may carry
    // `$` sequences that String.replace would otherwise interpret.
    return reportHtml
      .replace(/<\/head>/i, (m) => style + m)
      .replace(/<body[^>]*>/i, (m) => m + dashBar(ctx))
      .replace(/<\/body>/i, (m) => script + m);
  }
  return `${style}${dashBar(ctx)}${reportHtml}${script}`;
}

function basePage(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${esc(title)}</title><style>:root{color-scheme:light dark}` +
    `body{font-family:${FONT_MONO};font-size:${TEXT_SCALE["--text-sm"]};background:${ld("--bg-0")};color:${ld("--fg-1")};` +
    `padding:${SPACING["--space-8"]};}a{color:inherit}li{margin:${SPACING["--space-2"]} 0}</style>` +
    `</head><body>${body}</body></html>`;
}

export function archivePage(dates: string[]): string {
  const items = dates.map((d) => `<li><a href="/r/${esc(d)}">${esc(d)}</a></li>`).join("");
  return basePage("asl archive", `<h1>Reports</h1><ul>${items}</ul>`);
}

export function emptyPage(): string {
  return basePage("asl", `<h1>No reports yet</h1><p>Run <code>asl report</code> to generate the first one.</p>`);
}

export function notFoundPage(date: string): string {
  return basePage("asl — not found", `<h1>No report for ${esc(date)}</h1><p><a href="/archive">Browse the archive</a></p>`);
}
