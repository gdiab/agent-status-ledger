// `asl serve` — localhost dashboard over reportsDir (asl-eia). Serving is
// stateless per request (readdir/readFile every time) so the 7:30 launchd
// run's writes appear without coordination; only the refresh mutex lives in
// process.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Exec } from "./exec";
import { archivePage, emptyPage, notFoundPage, wrapReport } from "./render/dashboard";
import { dayKey } from "./time";

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

// CSRF guard: a hostile web page can fire a cross-origin form POST at
// 127.0.0.1. Browsers always attach Origin to POSTs, so a non-local Origin is
// rejected; an absent one (curl/CLI) is allowed.
function isAllowedOrigin(origin: string | null): boolean {
  if (origin === null) return true;
  try {
    const host = new URL(origin).hostname;
    return host === "127.0.0.1" || host === "localhost";
  } catch {
    return false;
  }
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
        const today = dayKey(now()); // same day key cli.ts writes
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
        POST: (req) => {
          if (!isAllowedOrigin(req.headers.get("origin"))) {
            return Response.json({ error: "cross-origin refresh rejected" }, { status: 403 });
          }
          if (state.running) return Response.json({ error: "a refresh is already running" }, { status: 409 });
          state.running = true;
          state.startedAt = now().toISOString();
          // Fire-and-forget: the response returns immediately and the header
          // bar polls /api/status. Promise.resolve().then() routes even a
          // synchronously-throwing Exec into the catch — otherwise a throw
          // here would wedge running=true forever.
          Promise.resolve()
            .then(() => deps.exec(deps.reportArgv))
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
