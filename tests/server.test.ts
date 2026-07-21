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
