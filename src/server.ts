// `asl serve` — localhost dashboard over reportsDir (asl-eia). Serving is
// stateless per request (readdir/readFile every time) so the 7:30 launchd
// run's writes appear without coordination; only the refresh mutex lives in
// process.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Exec } from "./exec";
import { esc } from "./render/esc";
import { COLORS_HEX, FONT_MONO, RADIUS, SPACING, TEXT_SCALE, TRACKING } from "./render/theme";

const REPORT_FILE = /^(\d{4}-\d{2}-\d{2})\.html$/;
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

// Filenames are constructed from validated dates, never from the URL path —
// this pair is the traversal guard.
export function isReportDate(s: string): boolean {
  return DATE_SHAPE.test(s);
}

export function listReportDates(reportsDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(reportsDir);
  } catch {
    return []; // missing/unreadable dir = no reports yet, not an error
  }
  return names
    .map((n) => REPORT_FILE.exec(n)?.[1])
    .filter((d): d is string => !!d)
    .sort()
    .reverse();
}

// All chrome color/type values resolve through theme.ts (asl-2h8's rule):
// the dashboard must not be born with hand-rolled hex drift.
const ld = (t: keyof typeof COLORS_HEX) => `light-dark(${COLORS_HEX[t].light}, ${COLORS_HEX[t].dark})`;

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
// report file is what's on screen.
const DASHBOARD_JS = `
const btn = document.getElementById("asl-dash-refresh");
const st = document.getElementById("asl-dash-status");
async function aslPoll() {
  const s = await (await fetch("/api/status")).json();
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
    return reportHtml
      .replace(/<\/head>/i, `${style}</head>`)
      .replace(/(<body[^>]*>)/i, `$1${dashBar(ctx)}`)
      .replace(/<\/body>/i, `${script}</body>`);
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

export interface RunState {
  running: boolean;
  startedAt: string | null;
  lastExit: { ok: boolean; finishedAt: string } | null;
}

export interface ServerDeps {
  reportsDir: string;
  port: number;
  exec: Exec;
  reportArgv: string[];
  now?: () => Date;
}

const htmlResponse = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

export function startServer(deps: ServerDeps) {
  const now = deps.now ?? (() => new Date());
  const state: RunState = { running: false, startedAt: null, lastExit: null };

  const serveDate = (date: string): Response => {
    const file = join(deps.reportsDir, `${date}.html`); // date pre-validated; never from the raw path
    if (!existsSync(file)) return htmlResponse(notFoundPage(date), 404);
    return htmlResponse(wrapReport(readFileSync(file, "utf8"), { date, dates: listReportDates(deps.reportsDir) }));
  };

  return Bun.serve({
    hostname: "127.0.0.1",
    port: deps.port,
    routes: {
      "/": () => {
        const dates = listReportDates(deps.reportsDir);
        if (dates.length === 0) return htmlResponse(emptyPage());
        const today = now().toISOString().slice(0, 10); // same day key cli.ts writes
        return serveDate(dates.includes(today) ? today : dates[0]!);
      },
      "/r/:date": (req) => {
        const date = req.params.date;
        if (!isReportDate(date)) return new Response("bad date — expected YYYY-MM-DD", { status: 400 });
        return serveDate(date);
      },
      "/archive": () => htmlResponse(archivePage(listReportDates(deps.reportsDir))),
      "/api/reports": () => Response.json(listReportDates(deps.reportsDir)),
      "/api/status": () => Response.json(state),
      "/api/refresh": {
        POST: () => {
          if (state.running) return Response.json({ error: "a refresh is already running" }, { status: 409 });
          state.running = true;
          state.startedAt = now().toISOString();
          // Fire-and-forget: the response returns immediately and the header
          // bar polls /api/status. makeSpawnExec never rejects, but the
          // catch keeps a surprise from wedging the mutex shut forever.
          deps.exec(deps.reportArgv)
            .catch(() => ({ ok: false, stdout: "", stderr: "" }))
            .then((r) => {
              state.running = false;
              state.lastExit = { ok: r.ok, finishedAt: now().toISOString() };
            });
          return Response.json({ started: true }, { status: 202 });
        },
      },
    },
    fetch: () => new Response("not found", { status: 404 }),
  });
}
