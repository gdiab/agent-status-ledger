import type { Report } from "../types";

export function renderJson(report: Report): string {
  return JSON.stringify(report, null, 2) + "\n";
}
