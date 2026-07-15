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
import { redact } from "../redact";
import type { RawSession } from "../types";

const CODE_EDIT_FILTER = '"k":"code.edit"';
// Human-readable citation stays a one-liner: cap the distinct files named.
const MAX_CITED_FILES = 5;

// Per-call timeout for the default real exec seam: observed real latency is
// ~60ms and a report run may make several calls per profile, so a hung
// binary (locked SQLite DB, stalled process) must fail fast rather than eat
// the report's time budget repeatedly.
export const ENGRAM_TIMEOUT_MS = 5_000;

// Query budget — every engram budget constant lives in this one block.
// Every call is a sequential blocking subprocess (~60ms observed, 5s
// timeout above), capped on every axis:
// - MAX_GREP_CANDIDATES (evidence upgrade): grep returns up to 10 hits by
//   default, but a grep by session UUID matches the real session far
//   stronger than a mention (hundreds of touch-count points vs a handful),
//   so if the real session is indexed at all it is in the first hits —
//   trying more just burns subprocess time on mention-only transcripts.
// - MAX_LINEAGE_CANDIDATES (dispatch lineage): the lineage grep must
//   represent MULTIPLE children — the parent's own tape always consumes one
//   slot (it matches its own uuid strongest), so an evidence-sized cap of 3
//   silently reported at most 2 of a 4-subagent fan-out. A parent-uuid grep
//   ranks real dispatch tapes high, so 6 covers realistic fan-out (parent
//   tape + 5 children) without an unbounded probe. When grep returns more
//   candidates than this cap, the walk flags truncation (see
//   grepPeekCandidates' `meta.truncated`), discoverDispatchLinks reports
//   the affected parents in `truncatedParents`, and report.ts surfaces it
//   as AgentReport.dispatchTruncated — rendered as "(list may be
//   incomplete)" so partial lineage is never presented as the whole truth.
// - MAX_SESSIONS_PER_PROFILE (evidence upgrade): sessions are tried
//   newest-first (recent sessions are the ones most likely to be in the
//   index and most relevant to today's report).
// - MAX_LINEAGE_SESSIONS (dispatch lineage): report-wide, because lineage
//   is a cross-profile query — one grep per candidate parent session,
//   newest-first.
// Worst-case ledger, per report:
//   lineage:  MAX_LINEAGE_SESSIONS × (1 grep + MAX_LINEAGE_CANDIDATES peeks)
//             = 10 × 7 = 70 calls
//   evidence: MAX_SESSIONS_PER_PROFILE × (1 grep + MAX_GREP_CANDIDATES peeks)
//             = 5 × 4 = 20 calls per claimed_only profile
//   report total: 70 + 20 × (number of claimed_only profiles)
const MAX_GREP_CANDIDATES = 3;
const MAX_LINEAGE_CANDIDATES = 6;
const MAX_SESSIONS_PER_PROFILE = 5;
const MAX_LINEAGE_SESSIONS = 10;

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
const SESSION_ID_SHAPE = /^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/;

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

export interface UpgradeResult {
  matched: boolean;
  // Branded: accidentally constructing an UpgradeResult with a raw
  // (unsanitized) string here is a compile error — see the honest scope of
  // that guarantee on SanitizedTapeText above.
  citation?: SanitizedTapeText;
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

// The parse-each-content-line-as-JSON loop shared by every tape reader:
// yields each peeked line's parsed tape event. Non-JSON lines (context
// lines, partial content) are skipped silently. All consumers work on the
// parsed event — ownership checks read `source`, marker checks read the
// parsed `content` string (real quotes, no JSON escaping); the raw line
// text has no consumer and is deliberately not yielded.
function* tapeEvents(
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
// dispatch lineage: validated uuid → grep → parsed response → capped
// candidate list → validated tape ids → peek (with the caller's filter) →
// parsed peek responses, yielded lazily so a caller that stops at its first
// hit never spends the remaining peek budget. Every reject path (invalid
// uuid, failed exec, malformed JSON, hostile tape id) is a silent skip —
// the fail-soft boundary lives in the entry points, not here.
// `meta.truncated` reports when grep returned more candidates than the cap
// allowed probing — the partial-results signal lineage callers propagate
// up to the report (evidence-upgrade callers don't pass meta and treat a
// truncated walk as an ordinary miss).
function* grepPeekCandidates(
  sessionUuid: string,
  binaryPath: string,
  exec: Exec,
  peekFilter: string,
  maxCandidates: number,
  meta?: { truncated: boolean },
): Generator<{ engramSid: string; response: Record<string, unknown> }> {
  if (!SESSION_ID_SHAPE.test(sessionUuid)) return;
  const grep = exec([binaryPath, "grep", sessionUuid]);
  if (!grep.ok) return;
  const grepObj = parseCliResponse(grep.stdout);
  if (!grepObj) return;

  const all = Array.isArray(grepObj.sessions) ? (grepObj.sessions as unknown[]) : [];
  if (meta) meta.truncated = all.length > maxCandidates;
  for (const candidate of all.slice(0, maxCandidates)) {
    const engramSid = (candidate as Record<string, unknown> | null)?.session_id;
    if (typeof engramSid !== "string" || !SESSION_ID_SHAPE.test(engramSid)) continue;

    const peek = exec([binaryPath, "peek", engramSid, "--grep-filter", peekFilter]);
    if (!peek.ok) continue;
    const response = parseCliResponse(peek.stdout);
    if (!response) continue;
    yield { engramSid, response };
  }
}

// Files edited under the queried harness UUID, per the peeked tape events.
// Empty array = this candidate fails the guard (no verified edits).
function verifiedEditedFiles(peekResponse: Record<string, unknown>, sessionUuid: string): string[] {
  const files = new Set<string>();
  for (const event of tapeEvents(peekResponse)) {
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
// separate future change. Never throws. extraPatterns is required for the
// same reason as sanitizeTapeText's: dropping the user's redactPatterns
// must never be a silent default.
export function upgradeEvidence(
  sessionUuid: string,
  binaryPath: string,
  exec: Exec,
  extraPatterns: string[],
): UpgradeResult {
  try {
    for (const { engramSid, response } of grepPeekCandidates(
      sessionUuid, binaryPath, exec, CODE_EDIT_FILTER, MAX_GREP_CANDIDATES,
    )) {
      const files = verifiedEditedFiles(response, sessionUuid);
      if (files.length === 0) continue;

      const shown = files.slice(0, MAX_CITED_FILES).join(", ");
      const more = files.length > MAX_CITED_FILES ? `, +${files.length - MAX_CITED_FILES} more` : "";
      return {
        matched: true,
        citation: sanitizeTapeText(
          `engram session ${engramSid}: observed code edits to ${shown}${more}`,
          extraPatterns,
        ),
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
//
// The options object is required and redactPatterns has no default: the
// user's config.redactPatterns must be threaded through explicitly, so a
// call site that opts out ([]) is visible as configuration, never an
// accidental omission. exec stays optional inside it (tests inject fakes;
// production omits it to run the real binary).
export interface CorroborateOptions {
  redactPatterns: string[];
  exec?: Exec;
}

export function corroborateSessions(
  sessions: RawSession[],
  cfg: EngramConfig,
  opts: CorroborateOptions,
): UpgradeResult {
  if (!cfg.enabled) return { matched: false };
  try {
    // enabled=true with no injected seam runs the real binary (same pattern
    // as narrative.ts's `fetchFn ?? fetch`); tests inject fakes.
    const realExec = opts.exec ?? makeSpawnExec(ENGRAM_TIMEOUT_MS);
    const newestFirst = [...sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    for (const session of newestFirst.slice(0, MAX_SESSIONS_PER_PROFILE)) {
      const result = upgradeEvidence(session.sessionId, cfg.binaryPath, realExec, opts.redactPatterns);
      if (result.matched) return result;
    }
    return { matched: false };
  } catch {
    return { matched: false };
  }
}

// ── Dispatch-marker lineage (orchestrator → subagent runs) ──────────────────
//
// Engram's dispatch-marker convention (engram specs/core/dispatch-marker.md):
// the dispatching party prepends `<engram-src id="<uuid>"/>` to the handoff
// prompt, so the uuid lands verbatim in both transcripts and engram records a
// dispatch_links row per tape at ingest. Engram's own chain traversal is only
// reachable through `explain <file/span/literal>` (grep emits a top-level
// `dispatch_lineage` key but always `[]`, and `explain --dispatch` was removed
// from the CLI), so ASL reconstructs the one hop it needs from the same two
// proven primitives the evidence upgrade uses — grep by uuid, peek by tape id:
//
//   1. In ASL's dispatch SOP the marker id is the ORCHESTRATOR's harness
//      session uuid, so `engram grep <parent-uuid>` finds every tape whose
//      transcript contains it — the orchestrator's own tape plus each
//      dispatched subagent's tape.
//   2. `engram peek <tape> --grep-filter <parent-uuid>` returns the tape
//      lines naming that uuid (the marker line and its context). A session
//      counts as a dispatched child only when ONE parsed tape event
//      satisfies ALL of, on that same event:
//        - the event is an inbound message (k == "msg.in" — the dispatch
//          prompt arrives as the subagent's incoming message; engram
//          specs/core/event-contract.md is the kind registry),
//        - its parsed `content` is a string that STARTS with the literal
//          marker `<engram-src id="<parent-uuid>"/>` (leading whitespace
//          only) — the spec says "The marker is prepended to the handoff
//          message" (engram specs/core/dispatch-marker.md), so a genuine
//          dispatch always carries it as a prefix; a marker quoted
//          mid-conversation or mid-text never matches — and
//        - its source.session_id is a DIFFERENT session known to this
//          report (the mention-only guard, inverted: here the mention IS
//          the evidence, but it must resolve to a session ASL can name).
//      Same-event correlation is load-bearing: a session merely QUOTING the
//      marker in a msg.out/tool.result (code review, test fixture), or a
//      peek response mixing an A-owned marker line with unrelated B-owned
//      context lines, must not mint an edge. The orchestrator's own tape
//      fails on both kind (it SENT the marker inside a tool call, k ==
//      "msg.out") and ownership, so it never self-links.
//
// Same discipline as the evidence upgrade: never throws, allowlisted argv
// only, bounded subprocess budget, and consuming CLI JSON only (never the
// SQLite dispatch_links table — the DB schema has no stability contract).

// The dispatch marker as a content PREFIX (leading whitespace only) for a
// validated session uuid, tested against a parsed event's `content` string
// (real quotes — JSON escaping is already undone by the parse). Safe to
// build as a regex: the uuid has already passed SESSION_ID_SHAPE (hex and
// dashes only), so it contains no regex metacharacters.
//
// Residual ambiguity, accepted: a user PASTING a dispatch prompt that
// BEGINS their message with someone else's marker produces a msg.in that is
// indistinguishable from a real dispatch with the data Engram exposes today
// (the marker text and the quoting session's own session_id are both
// genuine). The prefix rule eliminates the common quote positions
// (mid-conversation, mid-text); the message-initial paste stays a known
// false-lineage hole. Revisit if Engram ever exposes a checked provenance
// bit for dispatch links.
function markerPrefixPattern(sessionUuid: string): RegExp {
  return new RegExp(`^\\s*<engram-src id="${sessionUuid}"/>`);
}

export interface DispatchLink {
  parentSessionId: string; // orchestrator harness session uuid (the marker id)
  childSessionId: string;  // dispatched subagent harness session uuid
}

// The slice of RawSession lineage needs; report.ts flattens every profile's
// sessions into this shape so the connector never learns about profiles.
export interface LineageSession {
  sessionId: string;
  startedAt: string;
}

// Sessions dispatched BY `parentUuid`, resolved against the report's own
// session set (grep parent uuid, peek each candidate tape, keep sessions
// whose own inbound-message event carries the marker — see the pipeline
// comment above for the same-event correlation rule). `truncated` is true
// when grep found more candidate tapes than MAX_LINEAGE_CANDIDATES allowed
// peeking, i.e. `children` may be an undercount — surfaced so the report
// can say "list may be incomplete" rather than dropping the fact. Never
// throws.
export function findDispatchedSessions(
  parentUuid: string,
  knownSessionIds: ReadonlySet<string>,
  binaryPath: string,
  exec: Exec,
): { children: string[]; truncated: boolean } {
  try {
    if (!SESSION_ID_SHAPE.test(parentUuid)) return { children: [], truncated: false };
    const marker = markerPrefixPattern(parentUuid);
    const children = new Set<string>();
    const meta = { truncated: false };
    for (const { response } of grepPeekCandidates(
      parentUuid, binaryPath, exec, parentUuid, MAX_LINEAGE_CANDIDATES, meta,
    )) {
      for (const event of tapeEvents(response)) {
        // All three checks correlate to this ONE event: inbound-message
        // kind, marker as the prefix of its own parsed content, and its
        // owning session_id.
        if (event.k !== "msg.in") continue;
        if (typeof event.content !== "string" || !marker.test(event.content)) continue;
        const source = event.source as Record<string, unknown> | undefined;
        const sid = source?.session_id;
        if (typeof sid !== "string" || !SESSION_ID_SHAPE.test(sid)) continue;
        if (sid !== parentUuid && knownSessionIds.has(sid)) children.add(sid);
      }
    }
    return { children: [...children].sort(), truncated: meta.truncated };
  } catch {
    return { children: [], truncated: false };
  }
}

// What the lineage walk hands back to report generation: the discovered
// edges, plus the parents whose candidate walk was truncated (their
// `dispatched` list may be an undercount — report.ts turns each into
// AgentReport.dispatchTruncated on the owning profile's card).
export interface DispatchDiscovery {
  links: DispatchLink[];
  truncatedParents: string[]; // parent session uuids, in probe order
}

const EMPTY_DISCOVERY: DispatchDiscovery = { links: [], truncatedParents: [] };

// The lineage entry point for report generation: owns the enabled switch,
// the newest-first ordering, the report-wide probe budget, the default real
// exec seam, and the one fail-soft boundary — the corroborateSessions
// contract, verbatim. Every session in the report window is a candidate
// parent; links only ever join two sessions the report already knows.
export function discoverDispatchLinks(
  sessions: LineageSession[],
  cfg: EngramConfig,
  exec?: Exec,
): DispatchDiscovery {
  if (!cfg.enabled) return EMPTY_DISCOVERY;
  try {
    const knownIds = new Set(
      sessions.map((s) => s.sessionId).filter((id) => SESSION_ID_SHAPE.test(id)),
    );
    // A link joins two known sessions, so a report with fewer than two can
    // never produce one — return before spending any of the subprocess
    // budget proving it.
    if (knownIds.size < 2) return EMPTY_DISCOVERY;
    const realExec = exec ?? makeSpawnExec(ENGRAM_TIMEOUT_MS);
    const newestFirst = [...sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const links: DispatchLink[] = [];
    const truncatedParents: string[] = [];
    const seen = new Set<string>();
    for (const session of newestFirst.slice(0, MAX_LINEAGE_SESSIONS)) {
      const { children, truncated } = findDispatchedSessions(session.sessionId, knownIds, cfg.binaryPath, realExec);
      if (truncated) truncatedParents.push(session.sessionId);
      for (const child of children) {
        const key = `${session.sessionId} ${child}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({ parentSessionId: session.sessionId, childSessionId: child });
      }
    }
    return { links, truncatedParents };
  } catch {
    return EMPTY_DISCOVERY;
  }
}
