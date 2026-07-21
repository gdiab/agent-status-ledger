# Dashboard Web Server (asl-eia) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A localhost Bun.serve dashboard (`asl serve`) serving the latest HTML report, the historical archive, and an on-demand refresh that rewrites today's report files via the real CLI.

**Architecture:** New `src/server.ts` module with `startServer(deps)` returning the `Bun.serve` handle; reads `reportsDir` per request (no caching). Refresh spawns the real CLI (`report --no-email`) through the injected `Exec` seam behind a single-run mutex. A `com.gd.asl-dashboard.plist` (KeepAlive) owns lifecycle. Spec: `docs/superpowers/specs/2026-07-20-dashboard-server-design.md`.

**Tech Stack:** Bun (Bun.serve routes, bun:test), TypeScript, no new dependencies.

## Global Constraints

- Bind `127.0.0.1` only; port from config `dashboard_port`, default `4680`.
- Header-bar chrome styles come ONLY from `src/render/theme.ts` imports (`COLORS_HEX`, `FONT_MONO`, `TEXT_SCALE`, `TRACKING`, `SPACING`, `RADIUS`). No hand-rolled hex values or font stacks.
- Stored `reports/*.html` files are never modified — the header bar is injected into the HTTP response only.
- Manual refresh runs the real CLI with `--no-email`; no second report pipeline.
- HTML escaping via `esc` from `src/render/esc.ts`.
- Tests: `bun test`, port 0, temp dirs, stubbed `Exec` — no network, LLM, or email.
- Follow existing comment style: comments state constraints, not narration.

---

### Task 1: Config key `dashboard_port`

**Files:**
- Modify: `src/config.ts` (Config interface ~line 37, defaultConfig ~line 46, loadConfig ~line 74)
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: `Config.dashboardPort: number` (default `4680`), parsed from top-level TOML key `dashboard_port`.

- [ ] **Step 1: Write the failing tests** (append to `tests/config.test.ts`, matching its existing temp-file pattern)

```ts
describe("dashboard_port", () => {
  test("defaults to 4680", () => {
    expect(defaultConfig().dashboardPort).toBe(4680);
  });

  test("reads dashboard_port from TOML", () => {
    const dir = mkdtempSync(join(tmpdir(), "asl-config-"));
    const p = join(dir, "config.toml");
    writeFileSync(p, "dashboard_port = 5123\n");
    expect(loadConfig(p).dashboardPort).toBe(5123);
  });

  test("ignores non-numeric dashboard_port", () => {
    const dir = mkdtempSync(join(tmpdir(), "asl-config-"));
    const p = join(dir, "config.toml");
    writeFileSync(p, 'dashboard_port = "nope"\n');
    expect(loadConfig(p).dashboardPort).toBe(4680);
  });
});
```

(Inline mkdtemp/write matches the file's existing pattern — there is no shared temp-config helper.)

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/config.test.ts`
Expected: FAIL — `dashboardPort` does not exist on `Config`.

- [ ] **Step 3: Implement**

In the `Config` interface add:

```ts
  dashboardPort: number;   // asl serve bind port (localhost only)
```

In `defaultConfig()` add:

```ts
    dashboardPort: 4680,
```

In `loadConfig`, next to the other top-level scalars (after the `raw.model` line):

```ts
  if (typeof raw.dashboard_port === "number") c.dashboardPort = raw.dashboard_port;
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat(config): dashboard_port for asl serve (asl-eia)"
```

---

### Task 2: Report date listing and validation helpers

**Files:**
- Create: `src/server.ts`
- Test: `tests/server.test.ts`

**Interfaces:**
- Produces:
  - `listReportDates(reportsDir: string): string[]` — dates with an `.html` report, newest first; `[]` on unreadable dir.
  - `isReportDate(s: string): boolean` — strict `YYYY-MM-DD` shape.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/server.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isReportDate, listReportDates } from "../src/server";

function tempReports(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "asl-server-"));
  for (const f of files) writeFileSync(join(dir, f), "<html></html>");
  return dir;
}

describe("listReportDates", () => {
  test("lists html report dates newest first, ignoring other files", () => {
    const dir = tempReports([
      "2026-07-18.html", "2026-07-18.json", "2026-07-18.md",
      "2026-07-20.html", "notes.txt", "2026-07-19.html",
    ]);
    expect(listReportDates(dir)).toEqual(["2026-07-20", "2026-07-19", "2026-07-18"]);
  });

  test("returns [] for a missing directory", () => {
    expect(listReportDates("/nonexistent/asl-reports")).toEqual([]);
  });
});

describe("isReportDate", () => {
  test("accepts YYYY-MM-DD", () => {
    expect(isReportDate("2026-07-20")).toBe(true);
  });
  test("rejects traversal and junk", () => {
    for (const bad of ["../2026-07-20", "..%2f..", "2026-7-1", "2026-07-20.html", ""]) {
      expect(isReportDate(bad)).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/server.test.ts`
Expected: FAIL — cannot resolve `../src/server`.

- [ ] **Step 3: Implement** (`src/server.ts`)

```ts
// `asl serve` — localhost dashboard over reportsDir (asl-eia). Serving is
// stateless per request (readdir/readFile every time) so the 7:30 launchd
// run's writes appear without coordination; only the refresh mutex lives in
// process.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

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
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/server.test.ts
git commit -m "feat(server): report date listing + validation helpers (asl-eia)"
```

---

### Task 3: Header-bar wrapper and dashboard pages

**Files:**
- Modify: `src/server.ts`
- Test: `tests/server.test.ts`

**Interfaces:**
- Consumes: `esc` from `src/render/esc.ts`; theme tokens from `src/render/theme.ts`.
- Produces:
  - `wrapReport(reportHtml: string, ctx: { date: string; dates: string[] }): string` — injects header bar + style into `<head>`/`<body>` of a stored report; report markup otherwise preserved verbatim.
  - `archivePage(dates: string[]): string`, `emptyPage(): string`, `notFoundPage(date: string): string` — small standalone pages sharing one theme-token stylesheet.

- [ ] **Step 1: Write the failing tests** (append to `tests/server.test.ts`)

```ts
import { archivePage, emptyPage, notFoundPage, wrapReport } from "../src/server";

describe("wrapReport", () => {
  const report = '<html><head><title>r</title></head><body class="x"><main>REPORT BODY</main></body></html>';

  test("preserves the report markup verbatim inside the wrapper", () => {
    const out = wrapReport(report, { date: "2026-07-19", dates: ["2026-07-20", "2026-07-19", "2026-07-18"] });
    expect(out).toContain("<main>REPORT BODY</main>");
    expect(out).toContain('<body class="x">'); // body attributes untouched
  });

  test("injects bar with prev/next/archive links and refresh controls", () => {
    const out = wrapReport(report, { date: "2026-07-19", dates: ["2026-07-20", "2026-07-19", "2026-07-18"] });
    expect(out).toContain('id="asl-dash-bar"');
    expect(out).toContain('href="/r/2026-07-18"'); // older
    expect(out).toContain('href="/r/2026-07-20"'); // newer
    expect(out).toContain('href="/archive"');
    expect(out).toContain('id="asl-dash-refresh"');
  });

  test("omits prev/next at the ends of history", () => {
    const newest = wrapReport(report, { date: "2026-07-20", dates: ["2026-07-20", "2026-07-19"] });
    expect(newest).not.toContain('href="/r/2026-07-21"');
    const oldest = wrapReport(report, { date: "2026-07-19", dates: ["2026-07-20", "2026-07-19"] });
    expect(oldest).toContain('href="/r/2026-07-20"');
  });

  test("prepends chrome when the html has no body tag", () => {
    const out = wrapReport("<p>bare</p>", { date: "2026-07-19", dates: ["2026-07-19"] });
    expect(out).toContain('id="asl-dash-bar"');
    expect(out).toContain("<p>bare</p>");
  });
});

describe("dashboard pages", () => {
  test("archive lists dates newest first as links", () => {
    const out = archivePage(["2026-07-20", "2026-07-19"]);
    const i20 = out.indexOf("2026-07-20");
    const i19 = out.indexOf("2026-07-19");
    expect(i20).toBeGreaterThan(-1);
    expect(i20).toBeLessThan(i19);
    expect(out).toContain('href="/r/2026-07-20"');
  });

  test("empty and not-found pages point at recovery paths", () => {
    expect(emptyPage()).toContain("asl report");
    expect(notFoundPage("2026-01-01")).toContain('href="/archive"');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/server.test.ts`
Expected: FAIL — `wrapReport` not exported.

- [ ] **Step 3: Implement** (append to `src/server.ts`)

```ts
import { esc } from "./render/esc";
import { COLORS_HEX, FONT_MONO, RADIUS, SPACING, TEXT_SCALE, TRACKING } from "./render/theme";

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
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/server.test.ts
git commit -m "feat(server): header-bar wrapper + archive/empty/404 pages from theme tokens (asl-eia)"
```

---

### Task 4: `startServer` with report routes

**Files:**
- Modify: `src/server.ts`
- Test: `tests/server.test.ts`

**Interfaces:**
- Consumes: `Exec`, `ExecResult` from `src/exec.ts`; Task 2/3 helpers.
- Produces:

```ts
export interface RunState {
  running: boolean;
  startedAt: string | null;                       // ISO
  lastExit: { ok: boolean; finishedAt: string } | null;
}
export interface ServerDeps {
  reportsDir: string;
  port: number;             // 0 = ephemeral (tests)
  exec: Exec;               // refresh subprocess seam
  reportArgv: string[];     // argv exec runs on refresh
  now?: () => Date;         // injectable clock (latest-resolution tests)
}
export function startServer(deps: ServerDeps): ReturnType<typeof Bun.serve>;
```

(`lastExit` carries `ok`, not an exit code — the `Exec` seam deliberately collapses exit detail to `ok`; Task 5 amends the spec's `/api/status` line to match.)

- [ ] **Step 1: Write the failing tests** (append; refresh endpoints get their own task — here only report routes)

```ts
import { startServer, type ServerDeps } from "../src/server";
import type { Exec } from "../src/exec";

const execNever: Exec = async () => ({ ok: true, stdout: "", stderr: "" });

function makeServer(dir: string, over: Partial<ServerDeps> = {}) {
  return startServer({
    reportsDir: dir, port: 0, exec: execNever,
    reportArgv: ["true"], now: () => new Date("2026-07-20T12:00:00Z"), ...over,
  });
}

describe("startServer report routes", () => {
  test("/ serves today's report when present, wrapped", async () => {
    const dir = tempReports(["2026-07-19.html", "2026-07-20.html"]);
    const srv = makeServer(dir);
    try {
      const html = await (await fetch(`${srv.url}`)).text();
      expect(html).toContain('id="asl-dash-bar"');
      expect(html).toContain("2026-07-20");
    } finally { srv.stop(true); }
  });

  test("/ falls back to the most recent report when today's is absent", async () => {
    const dir = tempReports(["2026-07-18.html", "2026-07-19.html"]);
    const srv = makeServer(dir);
    try {
      const html = await (await fetch(`${srv.url}`)).text();
      expect(html).toContain("2026-07-19");
    } finally { srv.stop(true); }
  });

  test("/ with no reports shows the empty page", async () => {
    const srv = makeServer(tempReports([]));
    try {
      const r = await fetch(`${srv.url}`);
      expect(r.status).toBe(200);
      expect(await r.text()).toContain("No reports yet");
    } finally { srv.stop(true); }
  });

  test("/r/:date serves that day; unknown day 404s with archive link; junk 400s", async () => {
    const dir = tempReports(["2026-07-19.html"]);
    const srv = makeServer(dir);
    try {
      expect((await fetch(`${srv.url}r/2026-07-19`)).status).toBe(200);
      const missing = await fetch(`${srv.url}r/2026-01-01`);
      expect(missing.status).toBe(404);
      expect(await missing.text()).toContain('href="/archive"');
      expect((await fetch(`${srv.url}r/..%2f..%2fetc`)).status).toBe(400);
      expect((await fetch(`${srv.url}r/2026-7-1`)).status).toBe(400);
    } finally { srv.stop(true); }
  });

  test("/archive and /api/reports list dates newest first", async () => {
    const dir = tempReports(["2026-07-18.html", "2026-07-19.html"]);
    const srv = makeServer(dir);
    try {
      expect(await (await fetch(`${srv.url}api/reports`)).json()).toEqual(["2026-07-19", "2026-07-18"]);
      expect(await (await fetch(`${srv.url}archive`)).text()).toContain('href="/r/2026-07-19"');
    } finally { srv.stop(true); }
  });

  test("unknown routes 404", async () => {
    const srv = makeServer(tempReports([]));
    try {
      expect((await fetch(`${srv.url}nope`)).status).toBe(404);
    } finally { srv.stop(true); }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/server.test.ts`
Expected: FAIL — `startServer` not exported.

- [ ] **Step 3: Implement** (append to `src/server.ts`; add `import type { Exec } from "./exec";` at the top)

```ts
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
    },
    fetch: () => new Response("not found", { status: 404 }),
  });
}
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/server.test.ts
git commit -m "feat(server): startServer with report/archive routes on 127.0.0.1 (asl-eia)"
```

---

### Task 5: Refresh endpoint with mutex and status

**Files:**
- Modify: `src/server.ts` (inside `startServer`'s `routes`)
- Modify: `docs/superpowers/specs/2026-07-20-dashboard-server-design.md` (one line, see Step 3)
- Test: `tests/server.test.ts`

**Interfaces:**
- Consumes: `RunState`, `ServerDeps` from Task 4.
- Produces: `POST /api/refresh` → 202 `{started: true}` | 409 `{error}`; `GET /api/status` → `RunState` JSON reflecting subprocess lifecycle.

- [ ] **Step 1: Write the failing tests**

```ts
describe("refresh", () => {
  function gate() {
    let release!: (r: { ok: boolean }) => void;
    const done = new Promise<{ ok: boolean }>((res) => { release = res; });
    const calls: string[][] = [];
    const exec: Exec = async (argv) => {
      calls.push(argv);
      const r = await done;
      return { ok: r.ok, stdout: "", stderr: "" };
    };
    return { exec, release, calls };
  }

  test("202 starts the report argv; concurrent POST 409s; status tracks exit", async () => {
    const g = gate();
    const srv = makeServer(tempReports([]), { exec: g.exec, reportArgv: ["bun", "cli", "report", "--no-email"] });
    try {
      const first = await fetch(`${srv.url}api/refresh`, { method: "POST" });
      expect(first.status).toBe(202);
      expect(g.calls).toEqual([["bun", "cli", "report", "--no-email"]]);

      expect((await fetch(`${srv.url}api/refresh`, { method: "POST" })).status).toBe(409);
      let s = await (await fetch(`${srv.url}api/status`)).json();
      expect(s.running).toBe(true);
      expect(s.startedAt).not.toBeNull();

      g.release({ ok: true });
      await Bun.sleep(10);
      s = await (await fetch(`${srv.url}api/status`)).json();
      expect(s.running).toBe(false);
      expect(s.lastExit).toEqual({ ok: true, finishedAt: expect.any(String) });
      expect(g.calls.length).toBe(1); // 409'd POST spawned nothing
    } finally { srv.stop(true); }
  });

  test("failed run surfaces lastExit.ok=false and releases the mutex", async () => {
    const g = gate();
    const srv = makeServer(tempReports([]), { exec: g.exec });
    try {
      await fetch(`${srv.url}api/refresh`, { method: "POST" });
      g.release({ ok: false });
      await Bun.sleep(10);
      const s = await (await fetch(`${srv.url}api/status`)).json();
      expect(s.running).toBe(false);
      expect(s.lastExit.ok).toBe(false);
      // mutex released: a new refresh is accepted
      expect((await fetch(`${srv.url}api/refresh`, { method: "POST" })).status).toBe(202);
      g.release({ ok: true });
    } finally { srv.stop(true); }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/server.test.ts`
Expected: FAIL — POST /api/refresh returns 404.

- [ ] **Step 3: Implement**

Add to `routes` in `startServer`:

```ts
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
```

In the spec (`docs/superpowers/specs/2026-07-20-dashboard-server-design.md`), amend the `/api/status` route row to match the seam's shape:

```
| `GET /api/status` | `{running, startedAt, lastExit}` — `lastExit` is `{ok, finishedAt}` or null (`ok` from the Exec seam, which collapses exit codes) |
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/server.test.ts docs/superpowers/specs/2026-07-20-dashboard-server-design.md
git commit -m "feat(server): POST /api/refresh with single-run mutex + /api/status (asl-eia)"
```

---

### Task 6: CLI `asl serve` subcommand

**Files:**
- Modify: `src/cli.ts` (USAGE ~line 20, `main()` ~line 76)
- Test: none new — the branch is 6 lines of wiring over fully-tested parts; `tests/cli.test.ts` conventions cover `report` behavior only, and spawning a real server in CI would race on ports/config. Covered instead by doctor's probe (Task 7) and `bun test` type-checking the wiring.

**Interfaces:**
- Consumes: `startServer` (Task 4), `Config.dashboardPort` (Task 1), `makeSpawnExec` from `src/exec.ts`.

- [ ] **Step 1: Update USAGE**

```ts
const USAGE = `usage: asl report [--since 24h] [--open] [--no-llm] [--no-email] [--out DIR] [--layout ${HTML_LAYOUTS.join("|")}]
       asl serve
       asl doctor`;
```

- [ ] **Step 2: Add the branch** in `main()` after the doctor branch (`if (positionals[0] === "doctor") ...`):

```ts
  if (positionals[0] === "serve") {
    const config = loadConfig();
    // The refresh subprocess is the real CLI so trends/redaction/file writes
    // match the scheduled run exactly; 10min bound because LLM narrative +
    // connectors exceed the 60s CLI seam.
    const server = startServer({
      reportsDir: config.reportsDir,
      port: config.dashboardPort,
      exec: makeSpawnExec(600_000),
      reportArgv: [process.execPath, fileURLToPath(new URL("./cli.ts", import.meta.url)), "report", "--no-email"],
    });
    console.log(`asl dashboard: ${server.url}`);
    return; // Bun.serve keeps the process alive
  }
```

Add imports at the top of `src/cli.ts`:

```ts
import { fileURLToPath } from "node:url";
import { startServer } from "./server";
```

(`makeSpawnExec` is already imported.)

- [ ] **Step 3: Verify by hand**

Run: `bun src/cli.ts serve` then `curl -s http://127.0.0.1:4680/api/status`
Expected: `{"running":false,"startedAt":null,"lastExit":null}`. Ctrl-C the server.

Run: `bun test`
Expected: full suite PASS (type-checks the wiring).

- [ ] **Step 4: Commit**

```bash
git add src/cli.ts
git commit -m "feat(cli): asl serve subcommand (asl-eia)"
```

---

### Task 7: Doctor check and launchd plist

**Files:**
- Modify: `src/doctor.ts` (DoctorDeps ~line 30, `runDoctor` ~line 203)
- Modify: `src/cli.ts` (`runDoctorCli` ~line 31)
- Create: `scripts/com.gd.asl-dashboard.plist`
- Test: `tests/doctor.test.ts`

**Interfaces:**
- Produces:
  - `DASHBOARD_LAUNCHD_LABEL = "com.gd.asl-dashboard"` exported from `src/doctor.ts`.
  - `type HttpProbe = (url: string) => Promise<boolean>` and `DoctorDeps.httpProbe: HttpProbe`.
  - `checkDashboard(port: number, probe: HttpProbe): Promise<CheckResult>` — always `ok: true` (dashboard is optional; down = advisory detail, spec: warning not failure).

- [ ] **Step 1: Write the failing tests** (append to `tests/doctor.test.ts`)

```ts
import { checkDashboard, DASHBOARD_LAUNCHD_LABEL } from "../src/doctor";

describe("checkDashboard", () => {
  test("reports a responding server", async () => {
    const r = await checkDashboard(4680, async () => true);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("http://127.0.0.1:4680/api/status");
  });

  test("a down server is advisory, never a failure", async () => {
    const r = await checkDashboard(4680, async () => false);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("not responding");
    expect(r.detail).toContain(DASHBOARD_LAUNCHD_LABEL);
  });
});
```

Also update every `DoctorDeps` literal in `tests/doctor.test.ts` (the `runDoctor` describe block) to include:

```ts
    httpProbe: async () => false,
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/doctor.test.ts`
Expected: FAIL — `checkDashboard` not exported.

- [ ] **Step 3: Implement** in `src/doctor.ts`

```ts
export const DASHBOARD_LAUNCHD_LABEL = "com.gd.asl-dashboard";

// Injected instead of exec-with-curl: one fetch with a short bound, no
// subprocess needed. Doctor stays pure over its deps.
export type HttpProbe = (url: string) => Promise<boolean>;
```

Add to `DoctorDeps`:

```ts
  httpProbe: HttpProbe;
```

Add the check:

```ts
// The dashboard is optional (plist loaded = enabled), so a down server is
// advisory detail on an ok check — never a red X in an otherwise-healthy
// setup.
export async function checkDashboard(port: number, probe: HttpProbe): Promise<CheckResult> {
  const name = "dashboard server";
  const url = `http://127.0.0.1:${port}/api/status`;
  return (await probe(url))
    ? { name, ok: true, detail: `responding at ${url}` }
    : { name, ok: true, detail: `not responding at ${url} — optional; launchctl load -w ~/Library/LaunchAgents/${DASHBOARD_LAUNCHD_LABEL}.plist to enable` };
}
```

Append to the array returned by `runDoctor`:

```ts
    await checkDashboard(deps.config.dashboardPort, deps.httpProbe),
```

In `src/cli.ts` `runDoctorCli`, add to the `runDoctor({...})` deps:

```ts
    httpProbe: async (url) => {
      try {
        return (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok;
      } catch {
        return false;
      }
    },
```

- [ ] **Step 4: Create `scripts/com.gd.asl-dashboard.plist`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- asl dashboard (asl-eia): KeepAlive server for reports + history.
     Install: cp scripts/com.gd.asl-dashboard.plist ~/Library/LaunchAgents/
              launchctl load -w ~/Library/LaunchAgents/com.gd.asl-dashboard.plist
     bun is addressed absolutely because launchd provides no PATH
     (same as com.gd.asl-report). -->
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>com.gd.asl-dashboard</string>
	<key>ProgramArguments</key>
	<array>
		<string>/Users/gd/.bun/bin/bun</string>
		<string>/Users/gd/github/agent-status-ledger/src/cli.ts</string>
		<string>serve</string>
	</array>
	<key>KeepAlive</key>
	<true/>
	<key>RunAtLoad</key>
	<true/>
	<key>StandardOutPath</key>
	<string>/Users/gd/Library/Logs/asl-dashboard.log</string>
	<key>StandardErrorPath</key>
	<string>/Users/gd/Library/Logs/asl-dashboard.log</string>
</dict>
</plist>
```

- [ ] **Step 5: Run tests**

Run: `bun test`
Expected: full suite PASS (doctor tests included).

- [ ] **Step 6: Commit**

```bash
git add src/doctor.ts src/cli.ts tests/doctor.test.ts scripts/com.gd.asl-dashboard.plist
git commit -m "feat(doctor): advisory dashboard probe + launchd plist template (asl-eia)"
```

---

## Final verification (after all tasks)

- [ ] `bun test` — full suite passes.
- [ ] `bun src/cli.ts serve` → open `http://127.0.0.1:4680/` — today's report renders with the header bar; archive lists history; refresh button runs a report (watch `reports/<today>.html` mtime change) and reloads without sending email.
- [ ] `bun src/cli.ts doctor` — shows the dashboard check (responding while the server runs).
