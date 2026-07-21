import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archivePage, emptyPage, isReportDate, listReportDates, notFoundPage, wrapReport } from "../src/server";

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
