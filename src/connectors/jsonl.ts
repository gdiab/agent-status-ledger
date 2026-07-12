import { readFileSync, statSync } from "node:fs";
import type { RawSession, ScanOptions } from "../types";
import { redact } from "../redact";

export function firstLine(s: string): string {
  return s.split("\n", 1)[0]!.slice(0, 200);
}

const CONTEXT_MAX = 80;

// "exit code 143 — while Bash: xcrun simctl…" — gives the reader (and the
// narrative LLM) what the agent was doing when the error happened. Input is
// flattened, then redacted (built-in patterns plus the caller's user-supplied
// redactPatterns) BEFORE truncation: a secret that straddles the 80-char slice
// must not lose only its prefix past the length floor redaction patterns
// require. Callers own passing extraPatterns — the later fact-sheet redaction
// pass only ever sees the truncated string.
export function withContext(message: string, toolName: string, input: unknown, extraPatterns: string[] = []): string {
  const raw = input === undefined || input === null ? "" : typeof input === "string" ? input : JSON.stringify(input);
  const flat = redact(raw.replace(/\s+/g, " ").trim(), extraPatterns);
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
