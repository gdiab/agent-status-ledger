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
import type { CheckResult } from "../doctor";
import type { Exec } from "../email";

export type { Exec };

const CODE_EDIT_FILTER = '"k":"code.edit"';
// Human-readable citation stays a one-liner: cap the distinct files named.
const MAX_CITED_FILES = 5;
// Query budget: each candidate costs one blocking `engram peek` subprocess,
// and grep returns up to 10 hits by default. A grep by session UUID matches
// the real session far stronger than a mention (hundreds of touch-count
// points vs a handful), so if the real session is indexed at all it is in
// the first hits — trying more than a few just burns subprocess time on
// mention-only transcripts.
const MAX_GREP_CANDIDATES = 3;

export function checkEngramAvailable(binaryPath: string, exec: Exec): CheckResult {
  const name = "engram binary";
  const r = exec([binaryPath, "--help"]);
  return r.ok
    ? { name, ok: true, detail: `found via ${binaryPath}` }
    : {
        name,
        ok: false,
        detail: `${binaryPath} --help failed`,
        fix: `build engram from source (cargo build --release in the engram repo) and set connectors.engram.binary_path in ~/.config/asl/config.toml to the absolute binary path`,
      };
}

interface UpgradeResult {
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
// code.edit events and verify their source.session_id). Never throws.
export async function upgradeEvidence(
  sessionUuid: string,
  binaryPath: string,
  exec: Exec,
): Promise<UpgradeResult> {
  try {
    const grep = exec([binaryPath, "grep", sessionUuid]);
    if (!grep.ok) return { matched: false };
    const grepObj = parseCliResponse(grep.stdout);
    if (!grepObj) return { matched: false };

    const candidates = Array.isArray(grepObj.sessions)
      ? (grepObj.sessions as unknown[]).slice(0, MAX_GREP_CANDIDATES)
      : [];
    for (const candidate of candidates) {
      const engramSid = (candidate as Record<string, unknown> | null)?.session_id;
      if (typeof engramSid !== "string" || engramSid.length === 0) continue;

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
