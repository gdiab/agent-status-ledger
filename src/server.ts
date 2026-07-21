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
