import { readFileSync, statSync } from "node:fs";
import type { RawSession, ScanOptions } from "../types";
import { redact } from "../redact";

const LINE_MAX = 200;
const CONTEXT_MAX = 80;

// The one excerpting primitive: redaction (built-ins plus the user's
// config.redactPatterns) always precedes the first-line/length slice, so a
// secret straddling a truncation boundary can never leak its prefix.
// Connectors excerpt only through a Clip — never with a bare slice.
export type Clip = (s: string, max?: number) => string;

export function makeClip(patterns: string[]): Clip {
  return (s, max = LINE_MAX) => {
    const line = redact(s, patterns).split("\n", 1)[0]!;
    return line.length > max ? `${line.slice(0, max)}…` : line;
  };
}

// "exit code 143 — while Bash: xcrun simctl…" — gives the reader (and the
// narrative LLM) what the agent was doing when the error happened.
export function withContext(message: string, toolName: string, input: unknown, clip: Clip = makeClip([])): string {
  const raw = input === undefined || input === null ? "" : typeof input === "string" ? input : JSON.stringify(input);
  const flat = clip(raw.replace(/\s+/g, " ").trim(), CONTEXT_MAX);
  if (!flat) return `${message} — while ${toolName}`;
  return `${message} — while ${toolName}: ${flat}`;
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
