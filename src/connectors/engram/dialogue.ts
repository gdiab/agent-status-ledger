// ── Dialogue facts: ONE owned-dialogue walk feeding two pure folds ──────────
//
// Two report enrichments read a session's dialogue, which lives only in
// engram's tapes (harness parsing keeps no message text):
//
//   1. TASK KEYS (asl-1wm): bead IDs mentioned in dialogue, feeding
//      TaskThread derivation (src/threads.ts).
//   2. CONVERSATION SIGNALS (asl-cey; PRD open question 6, resolved yes):
//      whether the session was BUILD WORK or THINKING HELP, and — when a run
//      ends awaiting the user — WHAT the agent actually asked. The question
//      is quoted from the final msg.out, the first free-text DIALOGUE to
//      cross the tape boundary: it flows through sanitizeTapeText (asl-a5v)
//      like every tape-sourced string, and is additionally length-capped.
//
// Both wants are answered by the SAME walk (the asl-cey review's R1): grep
// the bare session UUID (the session's own tape slices rank far above
// mention-only transcripts), peek each candidate with the widest kind
// filter (classification needs messages, edits, and tool calls alike; the
// key fold's message-only interest is a strict subset), and keep only
// events whose source.session_id is the probed uuid (the mention-only
// guard). Every candidate up to the cap is read: engram watch slices tapes
// per debounce, so a bead mention, an event count, or the final msg.out can
// live in any slice. The two passes are then pure folds over that one
// owned-event stream — one grep + up to MAX_DIALOGUE_TAPES peeks per
// session serves both, where two back-to-back walks used to pay double.
//
// Task-key fold — redaction posture (the reason it stays count-and-key
// shaped): dialogue content is unredacted verbatim, so nothing free-text
// leaves the fold. A key must match taskKeyPattern — a configured tracker
// prefix plus a short base36 suffix — and additionally survive redact()
// unchanged (builtin + user patterns), else it is dropped, fail-closed. A
// ≤17-char shape-validated token cannot carry a usable secret, so no
// sanitizeTapeText call site is needed (the preferred design recorded on
// the bead asl-1wm).
//
// Task-key fold — known limitation (accepted): the ownership guard is
// provenance-based, not semantic. It rejects other sessions' tapes, but
// quotation inside the probed session's OWN dialogue still counts —
// "session A is handling asl-1wm", said in session B, makes B a member of
// the asl-1wm thread. Mention-based membership cannot tell discussing a
// task from advancing one without understanding the dialogue, and any cheap
// keyword heuristic would trade this over-inclusion for silent misses.
// Threads are grouping enrichment, not evidence: the cost of an
// over-inclusive member is a spurious card link, never a false claim.
//
// Signal fold — classification heuristic (deliberately simple and
// explainable):
//   - any owned code.edit event → "build" (the agent changed something);
//   - else, tool-call density above THINKING_MAX_TOOL_DENSITY per message
//     → "build" (running tests, git surgery, research scripts — work, even
//     without edits);
//   - else → "thinking" (dialogue-dominant: the agent helped the human
//     think, and the card should say so instead of reading like a build
//     run).
// A session with no owned events at all yields NO signal (absent field),
// never a guessed label.
//
// Live-shape gotcha (same as lineage): Task-tool subagent transcripts
// inherit the parent sessionId, so a parent session's counts include its
// in-session subagent runs' events. Fine for classification — a session
// that dispatched building subagents IS build work. (What is NOT fine is
// attaching one merged-stream signal to two profiles that share the id;
// report.ts suppresses those — see attachConversationSignals.)
import { BEAD_PREFIX_SHAPE, type EngramConfig } from "../../config";
import { makeSpawnExec, type Exec } from "../../exec";
import { redact } from "../../redact";
import type { InteractionKind } from "../../types";
import {
  ENGRAM_TIMEOUT_MS, MAX_DIALOGUE_TAPES, SESSION_ID_SHAPE, TAPE_TIMESTAMP_SHAPE,
  capSanitizedText, grepPeekCandidates, sanitizeTapeText, tapeEvents,
  type EngramPassOptions, type SessionRef, type SanitizedTapeText,
} from "./tape";

// Peek filter matching every tape event line's kind field ("k":"msg.in",
// "k":"code.edit", "k":"tool.call", …) — the signal fold needs all kinds,
// and the key fold's message events are a subset, so the widest filter that
// still selects event lines over prose serves both.
const EVENT_FILTER = '"k":"';

// Below this many tool calls per message event, an edit-free session reads
// as thinking help rather than build work. 0.25 = one tool call per four
// messages: pure conversation sits at ~0, while even light hands-on work
// (run the tests, check git status) clears it quickly. The comparison is
// strict (> not >=): exactly one tool call per four messages still reads as
// thinking.
const THINKING_MAX_TOOL_DENSITY = 0.25;

// The quoted question stays a one-liner on a report card, not a transcript
// excerpt: cap after sanitization and cut at the cap with an ellipsis (via
// the shared safe-boundary truncator, capSanitizedText in src/redact.ts).
const QUESTION_MAX_CHARS = 300;

export interface ConversationSignal {
  kind: InteractionKind;
  // The question the agent left the human with — present only when the
  // session's final owned msg.out actually contains one (no "?" = no
  // fabricated question). Branded: this is quoted dialogue, so it must be
  // impossible to construct the signal from an unsanitized string.
  finalQuestion?: SanitizedTapeText;
}

// Everything the one dialogue walk learned about a session: bead keys
// mentioned in its own dialogue (empty when none, or when no bead prefixes
// are configured) and its conversation signal (absent when engram observed
// no owned events).
export interface DialogueFacts {
  keys: string[];
  signal?: ConversationSignal;
}

// A bead ID as mentioned in dialogue: a CONFIGURED tracker prefix, dash,
// short base36 suffix (asl-1wm, asl-9pd, asl-cey). The prefix is an
// allowlist (EngramConfig.beadPrefixes), not a shape guess: live validation
// of a generic lowercase-word-dash-3 pattern minted 10 false keys for every
// real one — hyphenated English ("apt-get", "one-off", "in-app") repeated
// across sessions by shared prompt boilerplate groups exactly like a bead.
// Boundaries reject dash/word/'<' neighbors on both sides, so composite
// tokens never shed a false key: `<engram-src` (the dispatch marker,
// present verbatim in every dispatch prompt), `asl-wt-1wm` (worktree
// names), `asl-1wm-task-threads` (branch names).
//
// Prefixes are revalidated against BEAD_PREFIX_SHAPE HERE, not trusted from
// config load: the TOML loader filters, but buildReport accepts
// programmatically constructed Configs, and an unvalidated prefix like
// `.{0,100}` interpolated raw would widen the match window onto UNREDACTED
// tape dialogue (or, like `x)`, break the regex). Fail-soft per the
// connector's conventions — an invalid prefix is dropped individually, and
// if none survive the fold yields no keys (null pattern) instead of a
// degenerate regex; only shape-validated prefixes are ever interpolated,
// which makes them regex-inert (lowercase alphanumerics only).
function taskKeyPattern(beadPrefixes: string[]): RegExp | null {
  const valid = beadPrefixes.filter((p) => BEAD_PREFIX_SHAPE.test(p));
  if (valid.length === 0) return null;
  return new RegExp(`(?<![<\\w-])(?:${valid.join("|")})-[a-z0-9]{2,4}(?![\\w-])`, "g");
}

// Pure fold: bead IDs mentioned in the walked session's own dialogue.
// No configured (or no valid) prefix = null pattern = the fold is skipped
// outright — the walk it shares with the signal fold has already paid the
// subprocess cost either way.
export function foldTaskKeys(
  events: Record<string, unknown>[],
  beadPrefixes: string[],
  extraPatterns: string[],
): string[] {
  const pattern = taskKeyPattern(beadPrefixes);
  if (!pattern) return [];
  const keys = new Set<string>();
  for (const event of events) {
    if (event.k !== "msg.in" && event.k !== "msg.out") continue;
    if (typeof event.content !== "string") continue;
    for (const key of event.content.match(pattern) ?? []) {
      // Fail-closed redaction backstop: a token a redact pattern would
      // alter is dropped rather than surfaced or marker-mangled.
      if (redact(key, extraPatterns) === key) keys.add(key);
    }
  }
  return [...keys].sort();
}

// The last question sentence in a msg.out's content, or undefined when the
// message asks nothing. A "question" is a "?"-terminated sentence — the
// shape "here's what I did… which option do you want?" reliably ends with.
// The LAST one wins because agents front-load summary and end with the ask.
// Sentences are anchored at REAL boundaries — a sentence-ender followed by
// whitespace, or a newline — so a dot NOT followed by whitespace (filenames,
// versions, "e.g.") never restarts the sentence: "Keep my_file.ts or roll
// back?" quotes whole, not as "ts or roll back?".
function lastQuestionSentence(content: string): string | undefined {
  const segments = content.split(/\n+|(?<=[.!?])\s+/);
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i]!.trim();
    if (segment.endsWith("?")) return segment;
  }
  return undefined;
}

// Pure fold: classification + final question over the walked session's owned
// events. Undefined = no owned events at all (never a guessed label).
export function foldConversationSignal(
  events: Record<string, unknown>[],
  extraPatterns: string[],
): ConversationSignal | undefined {
  let messages = 0;
  let edits = 0;
  let tools = 0;
  // Newest owned msg.out across slices, compared by PARSED INSTANT — the
  // tape timestamp shape admits ±hh:mm offsets, so a lexicographic compare
  // on the raw string would misorder mixed-offset events. An event whose
  // timestamp can't anchor an ordering (empty, garbage, impossible instant)
  // can't claim to be "final", so it counts above but never competes here.
  let lastOutInstant = -Infinity;
  let lastOutContent: string | undefined;
  for (const event of events) {
    if (event.k === "msg.in" || event.k === "msg.out") messages++;
    else if (event.k === "code.edit") edits++;
    else if (event.k === "tool.call") tools++;
    if (
      event.k === "msg.out" &&
      typeof event.content === "string" &&
      typeof event.t === "string" &&
      TAPE_TIMESTAMP_SHAPE.test(event.t)
    ) {
      const instant = Date.parse(event.t);
      if (Number.isFinite(instant) && instant > lastOutInstant) {
        lastOutInstant = instant;
        lastOutContent = event.content;
      }
    }
  }
  if (messages === 0 && edits === 0 && tools === 0) return undefined;
  const kind: InteractionKind =
    edits > 0 || tools > messages * THINKING_MAX_TOOL_DENSITY ? "build" : "thinking";

  let finalQuestion: SanitizedTapeText | undefined;
  const question = lastOutContent === undefined ? undefined : lastQuestionSentence(lastOutContent);
  if (question !== undefined) {
    // Sanitize BEFORE capping: a cap on raw text could cut a secret in
    // half and hide it from the redactor.
    finalQuestion = capSanitizedText(sanitizeTapeText(question, extraPatterns), QUESTION_MAX_CHARS);
  }
  return { kind, ...(finalQuestion !== undefined ? { finalQuestion } : {}) };
}

// The one owned-dialogue walk: grep the bare uuid, peek every candidate up
// to the cap with the widest kind filter, keep only events owned by the
// probed session. Both folds consume its result.
async function walkOwnedEvents(
  sessionUuid: string,
  binaryPath: string,
  exec: Exec,
): Promise<Record<string, unknown>[]> {
  const owned: Record<string, unknown>[] = [];
  for await (const { response } of grepPeekCandidates(
    sessionUuid, binaryPath, exec, EVENT_FILTER, MAX_DIALOGUE_TAPES,
  )) {
    for (const event of tapeEvents(response)) {
      const source = event.source as Record<string, unknown> | undefined;
      if (source?.session_id !== sessionUuid) continue; // mention-only guard
      owned.push(event);
    }
  }
  return owned;
}

// Dialogue facts for one session: one walk, both folds. { keys: [] } (no
// signal) = engram observed nothing owned by this session, or any failure —
// enrichment, not evidence; indistinguishable by design. Never throws.
export async function findDialogueFacts(
  sessionUuid: string,
  beadPrefixes: string[],
  binaryPath: string,
  exec: Exec,
  extraPatterns: string[],
): Promise<DialogueFacts> {
  try {
    if (!SESSION_ID_SHAPE.test(sessionUuid)) return { keys: [] };
    const events = await walkOwnedEvents(sessionUuid, binaryPath, exec);
    const keys = foldTaskKeys(events, beadPrefixes, extraPatterns);
    const signal = foldConversationSignal(events, extraPatterns);
    return { keys, ...(signal !== undefined ? { signal } : {}) };
  } catch {
    return { keys: [] };
  }
}

// The dialogue-facts entry point for report generation: owns the enabled
// switch, the newest-first ordering, the probe-once dedupe, the default
// real exec seam, and the one fail-soft boundary — the
// discoverDispatchLinks contract, verbatim, and the ONLY copy of it among
// the dialogue passes (the walk is shared, so the orchestration is too).
// Returns sessionId → facts, entries only for sessions that yielded a key
// or a signal; disabled or failing engram returns an empty map — TaskThread
// derivation degrades to file-cluster keys alone, and cards read exactly as
// before (no label, no question).
export async function discoverDialogueFacts(
  sessions: SessionRef[],
  cfg: EngramConfig,
  opts: EngramPassOptions,
): Promise<Map<string, DialogueFacts>> {
  const factsBySession = new Map<string, DialogueFacts>();
  if (!cfg.enabled) return factsBySession;
  try {
    const realExec = opts.exec ?? makeSpawnExec(ENGRAM_TIMEOUT_MS);
    const newestFirst = [...sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    // Probe each id once — Task-tool subagent transcripts inherit the
    // dispatching session's sessionId, so windows can carry duplicates
    // (same rationale as discoverDispatchLinks' probed set).
    const probed = new Set<string>();
    for (const session of newestFirst) {
      if (!SESSION_ID_SHAPE.test(session.sessionId) || probed.has(session.sessionId)) continue;
      probed.add(session.sessionId);
      const facts = await findDialogueFacts(
        session.sessionId, cfg.beadPrefixes, cfg.binaryPath, realExec, opts.redactPatterns,
      );
      if (facts.keys.length > 0 || facts.signal) factsBySession.set(session.sessionId, facts);
    }
    return factsBySession;
  } catch {
    return factsBySession;
  }
}
