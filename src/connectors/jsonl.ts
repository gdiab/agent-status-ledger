import { readFileSync, statSync } from "node:fs";
import type { RawSession, ScanOptions } from "../types";

export function firstLine(s: string): string {
  return s.split("\n", 1)[0]!.slice(0, 200);
}

export function* jsonlEntries(text: string, path?: string): Generator<any> {
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      console.error(`warning: malformed jsonl line skipped in ${path ?? "input"}`);
      continue; // unknown/broken lines skipped, but never silently
    }
  }
}

export function scanSessionFile(
  path: string,
  opts: ScanOptions,
  parse: (text: string) => RawSession | null,
): RawSession | null {
  try {
    const stat = statSync(path);
    if (stat.mtime < opts.since || stat.mtime > opts.now) return null;
    const session = parse(readFileSync(path, "utf8"));
    if (!session) {
      console.error(`warning: no parseable session in ${path}`);
    }
    return session;
  } catch (e) {
    console.error(`warning: skipping ${path}: ${e}`);
    return null;
  }
}
