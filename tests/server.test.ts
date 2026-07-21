import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "../src/exec";
import {
  archivePage, emptyPage, isReportDate, listReportDates, notFoundPage,
  startServer, wrapReport, type ServerDeps,
} from "../src/server";

const execNever: Exec = async () => ({ ok: true, stdout: "", stderr: "" });

function makeServer(dir: string, over: Partial<ServerDeps> = {}) {
  return startServer({
    reportsDir: dir, port: 0, exec: execNever,
    reportArgv: ["true"], now: () => new Date("2026-07-20T12:00:00Z"), ...over,
  });
}

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
