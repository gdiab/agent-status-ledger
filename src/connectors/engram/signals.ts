// ── Conversation signals (work-vs-think classification + awaited question) ──
//
// The fourth engram pass (asl-cey): session dialogue carries two facts the
// harness parse cannot see (ASL keeps no message text), and both change how
// a card should read:
//
//   1. Whether the session was BUILD WORK or THINKING HELP — PRD open
//      question 6 ("should the report distinguish 'agent did work' from
//      'agent helped human think through work'?", resolved yes). A session
//      that is all dialogue must not be reported like a build run.
//   2. When a run ends awaiting the user, WHAT the agent actually asked —
//      the decision being waited on, not just a needs_human flag. The
//      question is quoted from the final msg.out, which makes it the first
//      free-text DIALOGUE to cross the tape boundary: it flows through
//      sanitizeTapeText (asl-a5v) at parse time like every tape-sourced
//      string, and is additionally length-capped here.
//
// Query shape: the evidence upgrade's proven walk — grep the bare session
// UUID (the session's own tape slices rank far above mention-only
// transcripts), peek each candidate with a kind-field filter that matches
// EVERY tape event line (classification needs messages, edits, and tool
// calls alike), and count only events whose source.session_id is the probed
// uuid (the same mention-only guard). Like the key walk, every candidate up
// to the cap is read: engram watch slices tapes per debounce, so counts and
// the final msg.out can live in any slice.
//
// Classification heuristic (deliberately simple and explainable):
//   - any owned code.edit event → "build" (the agent changed something);
//   - else, tool-call density above THINKING_MAX_TOOL_DENSITY per message
//     → "build" (running tests, git surgery, research scripts — work, even
//     without edits);
//   - else → "thinking" (dialogue-dominant: the agent helped the human
//     think, and the card should say so instead of reading like a build
//     run).
// A session with no owned events at all yields NO signal (absent map
// entry), never a guessed label.
//
// Live-shape gotcha (same as lineage): Task-tool subagent transcripts
// inherit the parent sessionId, so a parent session's counts include its
// in-session subagent runs' events. Fine for classification — a session
// that dispatched building subagents IS build work.
import type { EngramConfig } from "../../config";
import { makeSpawnExec, type Exec } from "../../exec";
import {
  ENGRAM_TIMEOUT_MS, MAX_SIGNAL_TAPES, SESSION_ID_SHAPE, TAPE_TIMESTAMP_SHAPE,
  grepPeekCandidates, sanitizeTapeText, tapeEvents,
  type CorroborateOptions, type LineageSession, type SanitizedTapeText,
} from "./tape";

// Peek filter matching every tape event line's kind field ("k":"msg.in",
// "k":"code.edit", "k":"tool.call", …) — classification needs all kinds, so
// the filter is the widest one that still selects event lines over prose.
const EVENT_FILTER = '"k":"';

// Below this many tool calls per message event, an edit-free session reads
// as thinking help rather than build work. 0.25 = one tool call per four
// messages: pure conversation sits at ~0, while even light hands-on work
// (run the tests, check git status) clears it quickly.
const THINKING_MAX_TOOL_DENSITY = 0.25;

// The quoted question stays a one-liner on a report card, not a transcript
// excerpt: cap after sanitization and cut at the cap with an ellipsis.
const QUESTION_MAX_CHARS = 300;

export interface ConversationSignal {
  kind: "build" | "thinking";
  // The question the agent left the human with — present only when the
  // session's final owned msg.out actually contains one (no "?" = no
  // fabricated question). Branded: this is quoted dialogue, so it must be
  // impossible to construct the signal from an unsanitized string.
  finalQuestion?: SanitizedTapeText;
}

// The last question sentence in a msg.out's content, or undefined when the
// message asks nothing. A "question" is a "?"-terminated sentence — the
// shape "here's what I did… which option do you want?" reliably ends with.
// The LAST one wins because agents front-load summary and end with the ask.
function lastQuestionSentence(content: string): string | undefined {
  const sentences = content.match(/[^.!?\n]+\?/g);
  const last = sentences?.[sentences.length - 1]?.trim();
  return last || undefined;
}

// Classification + final-question probe for one session. Undefined = engram
// observed nothing owned by this session (or any failure — enrichment, not
// evidence). Never throws.
export async function findConversationSignal(
  sessionUuid: string,
  binaryPath: string,
  exec: Exec,
  extraPatterns: string[],
): Promise<ConversationSignal | undefined> {
  try {
    if (!SESSION_ID_SHAPE.test(sessionUuid)) return undefined;
    let messages = 0;
    let edits = 0;
    let tools = 0;
    let lastOutAt = "";
    let lastOutContent: string | undefined;
    for await (const { response } of grepPeekCandidates(
      sessionUuid, binaryPath, exec, EVENT_FILTER, MAX_SIGNAL_TAPES,
    )) {
      for (const event of tapeEvents(response)) {
        const source = event.source as Record<string, unknown> | undefined;
        if (source?.session_id !== sessionUuid) continue; // mention-only guard
        if (event.k === "msg.in" || event.k === "msg.out") messages++;
        else if (event.k === "code.edit") edits++;
        else if (event.k === "tool.call") tools++;
        // Track the newest owned msg.out across slices; an event whose
        // timestamp can't anchor an ordering (empty, garbage, impossible
        // instant) can't claim to be "final", so it counts above but never
        // competes here.
        if (
          event.k === "msg.out" &&
          typeof event.content === "string" &&
          typeof event.t === "string" &&
          TAPE_TIMESTAMP_SHAPE.test(event.t) &&
          Number.isFinite(Date.parse(event.t)) &&
          event.t > lastOutAt
        ) {
          lastOutAt = event.t;
          lastOutContent = event.content;
        }
      }
    }
    if (messages === 0 && edits === 0 && tools === 0) return undefined;
    const kind: ConversationSignal["kind"] =
      edits > 0 || tools > messages * THINKING_MAX_TOOL_DENSITY ? "build" : "thinking";

    let finalQuestion: SanitizedTapeText | undefined;
    const question = lastOutContent === undefined ? undefined : lastQuestionSentence(lastOutContent);
    if (question !== undefined) {
      // Sanitize BEFORE capping: a cap on raw text could cut a secret in
      // half and hide it from the redactor.
      const sanitized = sanitizeTapeText(question, extraPatterns);
      finalQuestion =
        sanitized.length > QUESTION_MAX_CHARS
          ? (`${sanitized.slice(0, QUESTION_MAX_CHARS).trimEnd()}…` as SanitizedTapeText)
          : sanitized;
    }
    return { kind, ...(finalQuestion !== undefined ? { finalQuestion } : {}) };
  } catch {
    return undefined;
  }
}

// The conversation-signal entry point for report generation: owns the
// enabled switch, the newest-first ordering, the probe-once dedupe, the
// default real exec seam, and the one fail-soft boundary — the
// discoverTaskKeys contract, verbatim. Returns sessionId → signal, entries
// only for sessions engram observed; disabled or failing engram returns an
// empty map and cards read exactly as before (no label, no question).
export async function discoverConversationSignals(
  sessions: LineageSession[],
  cfg: EngramConfig,
  opts: CorroborateOptions,
): Promise<Map<string, ConversationSignal>> {
  const signalsBySession = new Map<string, ConversationSignal>();
  if (!cfg.enabled) return signalsBySession;
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
      const signal = await findConversationSignal(session.sessionId, cfg.binaryPath, realExec, opts.redactPatterns);
      if (signal) signalsBySession.set(session.sessionId, signal);
    }
    return signalsBySession;
  } catch {
    return signalsBySession;
  }
}
