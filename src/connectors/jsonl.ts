import { readFileSync, statSync } from "node:fs";
import type { RawSession, ScanOptions } from "../types";

export function firstLine(s: string): string {
  return s.split("\n", 1)[0]!.slice(0, 200);
}

const CONTEXT_MAX = 80;

// "exit code 143 — while Bash: xcrun simctl…" — gives the reader (and the
// narrative LLM) what the agent was doing when the error happened. Input is
// flattened and truncated; redaction runs later on the composed string.
export function withContext(message: string, toolName: string, input: unknown): string {
  const raw = input === undefined || input === null ? "" : typeof input === "string" ? input : JSON.stringify(input);
  const flat = raw.replace(/\s+/g, " ").trim();
  if (!flat) return `${message} — while ${toolName}`;
  const slice = flat.length > CONTEXT_MAX ? `${flat.slice(0, CONTEXT_MAX)}…` : flat;
  return `${message} — while ${toolName}: ${slice}`;
}

export function* jsonlEntries(text: string, path?: string): Generator<any> {
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // Deliberate: a truncated line usually means the file is mid-write by a live
      // agent, so we warn and continue rather than drop the whole session (dropping
      // would hide an active agent). File-level read errors still skip the file
      // (see scanSessionFile below).
      console.error(`warning: malformed jsonl line skipped in ${path ?? "input"}`);
      continue;
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
