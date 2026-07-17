// The shared spine of the Engram connector (github.com/clickety-clacks/engram):
// tape listing/reading (grep→peek), CLI response parsing, session-id and
// timestamp shape validation, the query-budget ledger, and the redaction
// choke point every tape-sourced string must pass through. The per-pass
// modules (evidence.ts, lineage.ts, task-keys.ts) build on these primitives;
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
import { redact } from "../../redact";
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
// - MAX_KEY_TAPES (task-key discovery): like the evidence grep, the key
//   probe greps the bare session UUID, where the session's OWN tape slices
//   rank far above mention-only transcripts (hundreds of touch-count points
//   vs a handful) — but engram watch emits per-debounce tape SLICES, so the
//   dialogue may be split across several top hits. Unlike the evidence walk
//   (which stops at its first verified hit), the key walk reads every
//   candidate up to the cap, because a bead mention can live in any slice.
//   3 matches MAX_GREP_CANDIDATES: the same ranking argument bounds both.
//   Keys are best-effort grouping hints, not completeness claims, so a
//   truncated walk is NOT surfaced (missing a mention degrades to a smaller
//   thread or none, never to a false statement).
// - Dispatch lineage and task-key discovery have NO report-wide session
//   cap: every session in the
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
//   task keys: (window sessions) × (1 grep + up to MAX_KEY_TAPES peeks)
//             = 4 calls per session worst-case — linear in the report
//             window; an unindexed session costs exactly 1 grep
//             (no_results), and the whole pass costs 0 calls when no bead
//             prefixes are configured.
//   report total: lineage + task keys + 20 × (number of claimed_only
//             profiles) — every term linear in the window or the profile
//             count, no quadratic axis.
export const MAX_GREP_CANDIDATES = 3;
export const MAX_MARKER_TAPES = 16;
export const MAX_SESSIONS_PER_PROFILE = 5;
export const MAX_KEY_TAPES = 3;

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

// Tape-sourced strings end up in every consumer surface (JSON, markdown,
// html, digest, email) and are assembled from engram-reported content
// (today: file paths; soon: quoted DIALOGUE), which is untrusted AND
// unredacted — engram stores verbatim transcripts. Neutralize at ingestion —
// control chars (incl. newlines, which would let "#"/markdown structures
// start a line), DEL, angle brackets, and Unicode format characters (\p{Cf}:
// zero-width space/joiners, word joiner, BOM, soft hyphen, bidi controls —
// all invisible in renderers, so a secret split by one would reconstruct on
// copy-paste and bidi controls could reorder the citation display) are
// stripped so the text is inert before it reaches any renderer. Citations
// are file paths plus counts, where no \p{Cf} character is load-bearing.
// This deliberately does not depend on renderer-side escaping (asl-xis).
//
// \p{Cf} alone is not enough: Unicode's Default_Ignorable_Code_Point
// property (DerivedCoreProperties.txt) also contains characters in other
// general categories that render as nothing — notably COMBINING GRAPHEME
// JOINER U+034F and the variation selectors U+FE00–FE0F / U+E0100–E01EF,
// which are nonspacing marks (\p{Mn}) — so they too can invisibly split a
// secret that reconstructs on copy-paste. JS regex cannot express
// \p{Default_Ignorable_Code_Point} directly, so the non-Cf members are
// enumerated explicitly below (do NOT widen to all of \p{Mn}: legitimate
// combining marks are load-bearing in NFD file paths, e.g. "café.ts" from
// macOS filesystems):
//   U+034F        COMBINING GRAPHEME JOINER (Mn)
//   U+115F..1160  HANGUL CHOSEONG/JUNGSEONG FILLER (Lo)
//   U+17B4..17B5  KHMER VOWEL INHERENT AQ/AA (Mn)
//   U+180B..180F  MONGOLIAN FREE VARIATION SELECTORS + VOWEL SEPARATOR
//   U+2065        reserved, default-ignorable (Cn)
//   U+3164        HANGUL FILLER (Lo)
//   U+FE00..FE0F  VARIATION SELECTOR-1..16 (Mn)
//   U+FFA0        HALFWIDTH HANGUL FILLER (Lo)
//   U+FFF0..FFF8  reserved, default-ignorable (Cn)
//   U+E0000..E0FFF plane-14 tags + VARIATION SELECTOR-17..256 + reserved
//
// Known fidelity tradeoff (accepted, security over fidelity): several
// stripped code points are legal, potentially load-bearing filename
// characters — SOFT HYPHEN U+00AD (a citation for "/repo/co­operate.ts"
// comes out naming "/repo/cooperate.ts", a different file), variation
// selectors (which can change glyph/semantic identity of the preceding
// character), Mongolian FVS, Khmer inherent vowels, and Hangul fillers.
// A stripped citation can therefore name a path that differs from the one
// actually edited. We accept the mislabeled citation rather than let an
// invisible or rendering-altering character through the boundary.
const TAPE_UNSAFE =
  /[\x00-\x1f\x7f<>]|\p{Cf}|[\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u2065\u3164\uFE00-\uFE0F\uFFA0\uFFF0-\uFFF8]|[\u{E0000}-\u{E0FFF}]/gu;

// Branded string marking a tape-sourced value that went through
// sanitizeTapeText. This is a compile-time convention against ACCIDENTAL
// misuse, not a proof: the brand can be forged with an assertion / `any` /
// JSON.parse, and it widens back to plain string where the value is stored
// (AgentReport.evidenceCitation). What it buys: sanitizeTapeText below is
// the single sanctioned producer, so a future field that quotes tape
// dialogue can declare this type and the compiler will flag any code path
// that forgot the choke point — as long as nobody casts around it.
declare const sanitizedTape: unique symbol;
export type SanitizedTapeText = string & { readonly [sanitizedTape]: true };

// THE redaction choke point for the Engram boundary (asl-a5v): every string
// that originates in engram subprocess output must pass through here at the
// point it is parsed into an ASL data structure — never at render time, so
// no future render path can bypass it. Composes the shared secret-matching
// rules from src/redact.ts (builtin + user extraPatterns — no new matching
// logic here, per asl-2u3) with the tape-specific structural hardening
// above. Redact runs on BOTH sides of the strip, because each order has an
// inverse evasion:
//  - strip-then-redact only: a boundary-dependent rule that matched the raw
//    text stops matching once the strip glues adjacent chars onto the secret
//    ("AKIA…F\x00X" → "AKIA…FX" breaks the \b…{16}\b rule);
//  - redact-then-strip only: a secret split by a stripped char slips past
//    the redactor as short fragments and is glued back into a live key
//    ("sk-fix\x00ture…" reassembles).
// Running redact → strip → redact covers both representations. Cost: redact
// runs twice per tape string — citations are one-liners and redact is a
// fixed list of regex passes, so this is noise next to the subprocess calls.
//
// extraPatterns is deliberately required (no default): a defaulted [] let
// call sites silently drop the user's redactPatterns while still receiving
// branded output. Passing [] must be a visible choice at the call site.
//
// Known cosmetic limitation (accepted): double-redact is not idempotent for
// pathological extraPatterns that match the marker itself — e.g. ["REDACTED"]
// or ["\\]"] mutate the first pass's [REDACTED] markers into noise like
// [[[REDACTED]]]. No secret survives (pinned by test); only the marker text
// gets mangled. The obvious fix — second pass splits on existing [REDACTED]
// markers and redacts only the non-marker segments — was tried and rejected:
// it blinds the second pass to marker-adjacent context, which demonstrably
// breaks redact.ts's glued-tail cleanup when the strip glues a secret tail
// onto a quoted marker (password="[REDACTED]"<ZWSP>xyz → the tail xyz
// survives under the split, but is caught by the full-string pass). A
// cosmetic defect does not warrant weakening a real redaction path.
export function sanitizeTapeText(s: string, extraPatterns: string[]): SanitizedTapeText {
  const preStripped = redact(s, extraPatterns);
  return redact(preStripped.replace(TAPE_UNSAFE, ""), extraPatterns) as SanitizedTapeText;
}

// The slice of RawSession the report-wide passes need; report.ts flattens
// every profile's sessions into this shape so the connector never learns
// about profiles.
export interface LineageSession {
  sessionId: string;
  startedAt: string;
}

// The options shape shared by every entry point that threads user redaction
// through (corroborateSessions, discoverTaskKeys): redactPatterns is
// required so dropping the user's config.redactPatterns is never a silent
// default; exec stays optional inside it (tests inject fakes; production
// omits it to run the real binary).
export interface CorroborateOptions {
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
