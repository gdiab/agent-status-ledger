// The shared spine of the Engram connector (github.com/clickety-clacks/engram):
// tape listing/reading (grep→peek), CLI response parsing, session-id and
// timestamp shape validation, the query-budget ledger, and the redaction
// choke point every tape-sourced string must pass through. The per-pass
// modules (evidence.ts, lineage.ts, dialogue.ts) build on these primitives;
// the public surface is re-exported by index.ts so importers see one module.
//
// Query design: ASL keys off the harness session UUID (RawSession.sessionId),
// which appears in every Engram tape event's source.session_id block.
//   1. `engram grep <uuid>` finds candidate Engram sessions. NOTE: grep's
//      `confidence` is a raw touch count (325.0 observed), not explain's 0-1
//      score — no confidence threshold is applied here.
//   2. `engram peek <engram-session-id> --grep-filter '"k":"code.edit"'`
//      returns raw tape event JSON, one event per session.content[] line.
//      The filter over-matches (context lines of other kinds come back too),
//      so each line is parsed and checked for its kind explicitly.
// Guard: grep can hit a session that merely *mentions* the UUID (e.g. an
// orchestrator transcript quoting a dispatch prompt), so a candidate only
// counts when its events actually carry source.session_id == uuid.
import type { Exec } from "../../exec";

// Per-call timeout for the default real exec seam: observed real latency is
// ~60ms and a report run may make several calls per profile, so a hung
// binary (locked SQLite DB, stalled process) must fail fast rather than eat
// the report's time budget repeatedly.
export const ENGRAM_TIMEOUT_MS = 5_000;

// Query budget — every engram budget constant lives in this one block.
// Every call is an awaited subprocess (~60ms observed, 5s timeout above) —
// issued one at a time within a walk, but never blocking the event loop, so
// concurrent profile workers and LLM fetches proceed while a call is in
// flight (asl-e2q). Capped on every axis:
// - MAX_GREP_CANDIDATES (evidence upgrade): grep returns up to 10 hits by
//   default, but a grep by session UUID matches the real session far
//   stronger than a mention (hundreds of touch-count points vs a handful),
//   so if the real session is indexed at all it is in the first hits —
//   trying more just burns subprocess time on mention-only transcripts.
// - MAX_MARKER_TAPES (dispatch lineage): unlike the evidence grep, the
//   lineage grep queries the dispatch-marker LITERAL, so it returns ONLY
//   marker-carrying tapes — one per dispatched run plus the occasional tape
//   quoting the marker verbatim (rejected by the event guards, but still a
//   peek each). The cap must cover a realistic fan-out whole: the live
//   validation shape was a 9-run fan-out plus 2 quoting tapes = 11 tapes,
//   so 16 gives headroom without an unbounded probe. The cap is also passed
//   as grep's --limit; grep's `total` still reports the index-wide match
//   count, and when it exceeds what the walk could peek the probe flags
//   truncation (see grepPeekCandidates' `meta.truncated`),
//   discoverDispatchLinks reports the affected parents in
//   `truncatedParents`, and report.ts surfaces it as
//   AgentReport.dispatchTruncated — rendered as "(list may be incomplete)"
//   so partial lineage is never presented as the whole truth.
// - MAX_SESSIONS_PER_PROFILE (evidence upgrade): sessions are tried
//   newest-first (recent sessions are the ones most likely to be in the
//   index and most relevant to today's report).
// - MAX_DIALOGUE_TAPES (dialogue facts: task keys + conversation signals):
//   the dialogue walk greps the bare session UUID, where the session's OWN
//   tape slices rank far above mention-only transcripts (hundreds of
//   touch-count points vs a handful) — but engram watch emits per-debounce
//   tape SLICES, so the dialogue may be split across several top hits.
//   Unlike the evidence walk (which stops at its first verified hit), the
//   dialogue walk reads every candidate up to the cap, because a bead
//   mention, a message/edit count, or the final msg.out can live in any
//   slice. 3 matches MAX_GREP_CANDIDATES: the same ranking argument bounds
//   both. ONE walk serves BOTH dialogue consumers: task keys and
//   conversation signals are pure folds over the same owned-event stream
//   (the peek filter is the widest kind filter, which the key fold's
//   message-only interest is a subset of), so the two passes cost one
//   walk's subprocesses, not two. Both outputs are enrichment, not
//   evidence, so a truncated walk is NOT surfaced (missing a slice degrades
//   to a smaller thread or a less-informed label, never a false statement).
// - Dispatch lineage and dialogue facts have NO report-wide session cap:
//   every session in the
//   window is probed (newest-first, for log readability). The bead's
//   contract is O(report sessions) and deterministic — a cap would silently
//   drop the oldest orchestrators exactly on busy multi-project days (live
//   validation: >10 sessions started after the day's real orchestrator, so
//   a 10-session budget never reached it). A session that dispatched
//   nothing costs exactly 1 grep (no_results); peeks are spent only on
//   marker-carrying tapes, which exist only where dispatches (or verbatim
//   quotes) exist.
// Worst-case ledger, per report:
//   lineage:  (window sessions) × 1 grep + (marker tapes that exist, up to
//             MAX_MARKER_TAPES per parent) peeks — linear in the report
//             window, ~1 call per session in the common case.
//   evidence: MAX_SESSIONS_PER_PROFILE × (1 grep + MAX_GREP_CANDIDATES peeks)
//             = 5 × 4 = 20 calls per claimed_only profile
//   dialogue: (window sessions) × (1 grep + up to MAX_DIALOGUE_TAPES peeks)
//             = 4 calls per session worst-case — linear in the report
//             window; an unindexed session costs exactly 1 grep
//             (no_results). This single walk feeds both the task-key and
//             the conversation-signal folds (formerly two identical walks
//             at 8 calls per session worst-case); it runs whenever engram
//             is enabled (classification needs no bead prefixes — with none
//             configured only the key fold is skipped, not the walk).
//   report total: lineage + dialogue + 20 × (number of claimed_only
//             profiles) — every term linear in the window or the profile
//             count, no quadratic axis.
export const MAX_GREP_CANDIDATES = 3;
export const MAX_MARKER_TAPES = 16;
export const MAX_SESSIONS_PER_PROFILE = 5;
export const MAX_DIALOGUE_TAPES = 3;

// Session ids reach argv from two untrusted sources: harness transcripts
// (RawSession.sessionId is parsed from log files) and engram's own grep
// output. Allowlist, don't blocklist: Claude Code/Codex session ids are
// UUIDs and engram session ids are 64-char hex hashes — both fit a plain
// hex-and-dashes shape that starts with a hex digit. The leading-hex
// requirement matters: dashes alone are inside the character class, so
// option-shaped values built purely from allowlisted characters
// ("--------", "--dead-beef") would otherwise slip through. Anything else
// (option-looking strings, shell metacharacters, empty) is rejected before
// any exec, so a hostile id can never become an engram CLI option.
export const SESSION_ID_SHAPE = /^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/;

// The ISO-8601 instant engram stamps on every tape event's `t`. Used to
// validate a timestamp before it anchors an in-session run identity in
// findDispatches: an empty or garbage `t` must be rejected outright, not
// used as a dedupe key (a degenerate key like "" would collapse every
// distinct dispatch that shares the junk value into one run).
export const TAPE_TIMESTAMP_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

// The redaction choke point (sanitizeTapeText) and its SanitizedTapeText
// brand live in src/redact.ts — the report model types its tape-quoting
// fields with the brand, so the brand and its single sanctioned producer
// belong beside the redaction rules, not in a connector module (asl-cey,
// resolving the asl-a5v deferred design note). Re-exported here so the
// connector's modules and public surface keep one import path.
export { capSanitizedText, sanitizeTapeText, type SanitizedTapeText } from "../../redact";

// The slice of RawSession the report-wide passes need; report.ts flattens
// every profile's sessions into this shape so the connector never learns
// about profiles. Serves all report-wide passes (lineage, dialogue facts),
// hence the pass-neutral name.
export interface SessionRef {
  sessionId: string;
  startedAt: string;
}

// The options shape shared by every entry point that threads user redaction
// through (corroborateSessions, discoverDialogueFacts): redactPatterns is
// required so dropping the user's config.redactPatterns is never a silent
// default; exec stays optional inside it (tests inject fakes; production
// omits it to run the real binary).
export interface EngramPassOptions {
  redactPatterns: string[];
  exec?: Exec;
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
export function parseCliResponse(stdout: string): Record<string, unknown> | undefined {
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

// The parse-each-content-line-as-JSON loop shared by every tape reader:
// yields each peeked line's parsed tape event. Non-JSON lines (context
// lines, partial content) are skipped silently. All consumers work on the
// parsed event — ownership checks read `source`, marker checks read the
// parsed `content` string (real quotes, no JSON escaping); the raw line
// text has no consumer and is deliberately not yielded.
export function* tapeEvents(
  peekResponse: Record<string, unknown>,
): Generator<Record<string, unknown>> {
  const session = peekResponse.session as Record<string, unknown> | undefined;
  const content = Array.isArray(session?.content) ? (session.content as unknown[]) : [];
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
    yield ev as Record<string, unknown>;
  }
}

// The canonical grep→peek candidate walk shared by the evidence upgrade and
// dispatch lineage: grep query → parsed response → capped candidate list →
// validated tape ids → peek (with the caller's filter) → parsed peek
// responses, yielded lazily (async generators pull on demand) so a caller
// that stops at its first hit never spends the remaining peek budget. Every
// reject path (failed exec, malformed JSON, hostile tape id) is a silent
// skip — the fail-soft boundary lives in the entry points, not here.
// `grepQuery` is caller-constructed from a SESSION_ID_SHAPE-validated uuid
// — the bare uuid (evidence upgrade) or the marker literal built around one
// (dispatch lineage) — so it is never option-shaped; the caller owns that
// validation because only it knows which shape it is building. The
// option-shape rejection below is a fail-closed backstop for future
// callers, not a substitute for that validation.
// `meta.truncated` reports when grep matched more tapes index-wide (its
// `total`) than the cap allowed probing — the partial-results signal
// lineage callers propagate up to the report (evidence-upgrade callers
// don't pass meta and treat a truncated walk as an ordinary miss).
export async function* grepPeekCandidates(
  grepQuery: string,
  binaryPath: string,
  exec: Exec,
  peekFilter: string,
  maxCandidates: number,
  meta?: { truncated: boolean },
): AsyncGenerator<{ engramSid: string; response: Record<string, unknown> }> {
  if (grepQuery.startsWith("-")) return;
  const grep = await exec([binaryPath, "grep", grepQuery, "--limit", String(maxCandidates)]);
  if (!grep.ok) return;
  const grepObj = parseCliResponse(grep.stdout);
  if (!grepObj) return;

  const all = Array.isArray(grepObj.sessions) ? (grepObj.sessions as unknown[]) : [];
  // `total` is grep's index-wide match count. An older CLI without the
  // field leaves truncation unknowable: below the cap the returned list is
  // necessarily complete (no fabricated truncation), but a response that
  // fills the cap may have been cut exactly at it, so it is conservatively
  // flagged truncated rather than presenting possibly-partial results as
  // the whole truth.
  if (meta) {
    meta.truncated =
      typeof grepObj.total === "number"
        ? Math.max(grepObj.total, all.length) > Math.min(all.length, maxCandidates)
        : all.length >= maxCandidates;
  }
  for (const candidate of all.slice(0, maxCandidates)) {
    const engramSid = (candidate as Record<string, unknown> | null)?.session_id;
    if (typeof engramSid !== "string" || !SESSION_ID_SHAPE.test(engramSid)) continue;

    const peek = await exec([binaryPath, "peek", engramSid, "--grep-filter", peekFilter]);
    if (!peek.ok) continue;
    const response = parseCliResponse(peek.stdout);
    if (!response) continue;
    yield { engramSid, response };
  }
}
