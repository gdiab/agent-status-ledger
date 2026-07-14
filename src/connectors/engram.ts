// Optional, fail-soft enrichment via Engram (github.com/clickety-clacks/engram):
// corroborates a claimed_only completion claim against Engram's own
// independently-parsed transcript tapes, upgrading evidence to
// partially_proven when Engram observed real code edits in that session.
// Never a hard dependency — every function here returns a "no match"/failure
// value instead of throwing, mirroring email.ts's never-throws contract.
//
// Query design: ASL keys off the harness session UUID (RawSession.sessionId),
// which appears in every Engram tape event's source.session_id block.
//   1. `engram grep <uuid>` finds candidate Engram sessions. NOTE: grep's
//      `confidence` is a raw touch count (325.0 observed), not explain's 0-1
//      score — no confidence threshold is applied here.
//   2. `engram peek <engram-session-id> --grep-filter '"k":"code.edit"'`
//      returns raw tape event JSON, one event per session.content[] line.
//      The filter over-matches (context lines of other kinds come back too),
//      so each line is parsed and checked for k == "code.edit" explicitly.
// Guard: grep can hit a session that merely *mentions* the UUID (e.g. an
// orchestrator transcript quoting a dispatch prompt), so a candidate only
// counts when its code.edit events actually carry source.session_id == uuid.
import type { EngramConfig } from "../config";
import { makeSpawnExec, type Exec } from "../exec";
import type { RawSession } from "../types";

const CODE_EDIT_FILTER = '"k":"code.edit"';
// Human-readable citation stays a one-liner: cap the distinct files named.
const MAX_CITED_FILES = 5;

// Per-call timeout for the default real exec seam: observed real latency is
// ~60ms and a report run may make several calls per profile, so a hung
// binary (locked SQLite DB, stalled process) must fail fast rather than eat
// the report's time budget repeatedly.
export const ENGRAM_TIMEOUT_MS = 5_000;

// Query budget — every call is a sequential blocking subprocess (~60ms
// observed), so both axes are capped side by side here:
// - MAX_GREP_CANDIDATES: grep returns up to 10 hits by default, but a grep
//   by session UUID matches the real session far stronger than a mention
//   (hundreds of touch-count points vs a handful), so if the real session
//   is indexed at all it is in the first hits — trying more just burns
//   subprocess time on mention-only transcripts.
// - MAX_SESSIONS_PER_PROFILE: sessions are tried newest-first (recent
//   sessions are the ones most likely to be in the index and most relevant
//   to today's report). Worst case per claimed_only profile:
//   5 × (1 grep + 3 peeks) = 20 subprocess calls.
const MAX_GREP_CANDIDATES = 3;
const MAX_SESSIONS_PER_PROFILE = 5;

// Session ids reach argv from two untrusted sources: harness transcripts
// (RawSession.sessionId is parsed from log files) and engram's own grep
// output. Allowlist, don't blocklist: Claude Code/Codex session ids are
// UUIDs and engram session ids are 64-char hex hashes — both fit a plain
// hex-and-dashes shape. Anything else (option-looking strings like
// "--help", shell metacharacters, empty) is rejected before any exec, so a
// hostile id can never become an engram CLI option.
const SESSION_ID_SHAPE = /^[0-9a-fA-F-]{8,64}$/;

export interface UpgradeResult {
  matched: boolean;
  citation?: string;
}

// Every engram command prints two lines of config/db path info before the
// JSON payload; scan backwards for the last line that looks like a JSON
// object rather than assuming an exact prefix line count.
function extractJsonLine(stdout: string): string | undefined {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line.startsWith("{")) return line;
  }
  return undefined;
}

// Parses an engram CLI response: undefined on malformed JSON or an explicit
// error payload ({"error":"no_results"} / {"error":"session_not_found"} —
// both observed with exit code 0, so the error key is the reliable signal).
function parseCliResponse(stdout: string): Record<string, unknown> | undefined {
  const jsonLine = extractJsonLine(stdout);
  if (!jsonLine) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonLine);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  if ("error" in obj) return undefined;
  return obj;
}

// Files edited under the queried harness UUID, per the peeked tape events.
// Empty array = this candidate fails the guard (no verified edits).
function verifiedEditedFiles(peekResponse: Record<string, unknown>, sessionUuid: string): string[] {
  const session = peekResponse.session as Record<string, unknown> | undefined;
  const content = Array.isArray(session?.content) ? (session.content as unknown[]) : [];
  const files = new Set<string>();
  for (const entry of content) {
    const text = (entry as Record<string, unknown> | null)?.text;
    if (typeof text !== "string") continue;
    let ev: unknown;
    try {
      ev = JSON.parse(text);
    } catch {
      continue; // context line or partial content, not a tape event
    }
    if (typeof ev !== "object" || ev === null) continue;
    const event = ev as Record<string, unknown>;
    if (event.k !== "code.edit") continue;
    const source = event.source as Record<string, unknown> | undefined;
    if (source?.session_id !== sessionUuid) continue; // mention-only guard
    if (typeof event.file === "string") files.add(event.file);
  }
  return [...files].sort();
}

// Asks Engram whether it independently observed real code edits in the
// harness session `sessionUuid` (grep by UUID, then peek each candidate's
// code.edit events and verify their source.session_id). Synchronous by
// design — the Exec seam is Bun.spawnSync underneath; an async exec is a
// separate future change. Never throws.
export function upgradeEvidence(
  sessionUuid: string,
  binaryPath: string,
  exec: Exec,
): UpgradeResult {
  try {
    if (!SESSION_ID_SHAPE.test(sessionUuid)) return { matched: false };
    const grep = exec([binaryPath, "grep", sessionUuid]);
    if (!grep.ok) return { matched: false };
    const grepObj = parseCliResponse(grep.stdout);
    if (!grepObj) return { matched: false };

    const candidates = Array.isArray(grepObj.sessions)
      ? (grepObj.sessions as unknown[]).slice(0, MAX_GREP_CANDIDATES)
      : [];
    for (const candidate of candidates) {
      const engramSid = (candidate as Record<string, unknown> | null)?.session_id;
      if (typeof engramSid !== "string" || !SESSION_ID_SHAPE.test(engramSid)) continue;

      const peek = exec([binaryPath, "peek", engramSid, "--grep-filter", CODE_EDIT_FILTER]);
      if (!peek.ok) continue;
      const peekObj = parseCliResponse(peek.stdout);
      if (!peekObj) continue;

      const files = verifiedEditedFiles(peekObj, sessionUuid);
      if (files.length === 0) continue;

      const shown = files.slice(0, MAX_CITED_FILES).join(", ");
      const more = files.length > MAX_CITED_FILES ? `, +${files.length - MAX_CITED_FILES} more` : "";
      return {
        matched: true,
        citation: `engram session ${engramSid}: observed code edits to ${shown}${more}`,
      };
    }
    return { matched: false };
  } catch {
    return { matched: false };
  }
}

// The connector's single entry point for report generation: owns the
// enabled switch, the newest-first session ordering, both query budgets,
// the default real (timeout-bounded) exec seam, and the one fail-soft
// boundary — mirroring sendReportEmail's never-throws contract (asl-533).
// Callers gate on evidence level; everything engram-shaped lives here.
export function corroborateSessions(
  sessions: RawSession[],
  cfg: EngramConfig,
  exec?: Exec,
): UpgradeResult {
  if (!cfg.enabled) return { matched: false };
  try {
    // enabled=true with no injected seam runs the real binary (same pattern
    // as narrative.ts's `fetchFn ?? fetch`); tests inject fakes.
    const realExec = exec ?? makeSpawnExec(ENGRAM_TIMEOUT_MS);
    const newestFirst = [...sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    for (const session of newestFirst.slice(0, MAX_SESSIONS_PER_PROFILE)) {
      const result = upgradeEvidence(session.sessionId, cfg.binaryPath, realExec);
      if (result.matched) return result;
    }
    return { matched: false };
  } catch {
    return { matched: false };
  }
}
