// ── Task-key discovery (bead IDs mentioned in dialogue) ─────────────────────
//
// The third engram pass (asl-1wm): TaskThread derivation (src/threads.ts)
// keys threads off bead IDs mentioned in session dialogue, and dialogue
// lives only in engram's tapes — harness parsing keeps no message text. The
// pass reuses the evidence upgrade's proven query shape: grep the bare
// session UUID (the session's own tape slices rank far above mention-only
// transcripts), peek each candidate filtered to message events, and accept
// tokens only from events whose source.session_id is the probed uuid (the
// same mention-only guard) — a transcript QUOTING another session's
// dialogue must not donate keys to it.
//
// Known limitation (accepted): the ownership guard is provenance-based,
// not semantic. It rejects other sessions' tapes, but quotation inside the
// probed session's OWN dialogue still counts — "session A is handling
// asl-1wm", said in session B, makes B a member of the asl-1wm thread.
// Mention-based membership cannot tell discussing a task from advancing
// one without understanding the dialogue, and any cheap keyword heuristic
// ("handled by", "belongs to") would trade this over-inclusion for silent
// misses. Threads are grouping enrichment, not evidence: the cost of an
// over-inclusive member is a spurious card link, never a false claim.
//
// Redaction posture (the reason this stays count-and-key shaped): dialogue
// content is unredacted verbatim, so nothing free-text leaves this pass.
// A key must match taskKeyPattern — a configured tracker prefix plus a
// short base36 suffix — and additionally survive redact() unchanged
// (builtin + user patterns), else it is dropped, fail-closed. A ≤17-char
// shape-validated token cannot carry a usable secret, so no
// sanitizeTapeText call site is needed (the preferred design recorded on
// the bead).
import { BEAD_PREFIX_SHAPE, type EngramConfig } from "../../config";
import { makeSpawnExec, type Exec } from "../../exec";
import { redact } from "../../redact";
import {
  ENGRAM_TIMEOUT_MS, MAX_KEY_TAPES, SESSION_ID_SHAPE,
  grepPeekCandidates, tapeEvents,
  type CorroborateOptions, type LineageSession,
} from "./tape";

// Peek filter for dialogue lines: matches the raw tape line's kind field for
// both msg.in and msg.out ("k":"msg.in" / "k":"msg.out"); like every peek
// filter it over-matches context lines, so each parsed event's kind is
// checked explicitly below.
const MSG_FILTER = '"k":"msg.';

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
// if none survive the pass yields no keys (null pattern) instead of a
// degenerate regex; only shape-validated prefixes are ever interpolated,
// which makes them regex-inert (lowercase alphanumerics only).
function taskKeyPattern(beadPrefixes: string[]): RegExp | null {
  const valid = beadPrefixes.filter((p) => BEAD_PREFIX_SHAPE.test(p));
  if (valid.length === 0) return null;
  return new RegExp(`(?<![<\\w-])(?:${valid.join("|")})-[a-z0-9]{2,4}(?![\\w-])`, "g");
}

// Bead IDs mentioned in `sessionUuid`'s own dialogue, per engram's tapes.
// Empty array = none found or any failure (indistinguishable by design —
// keys are enrichment, not evidence). Never throws.
export async function findTaskKeys(
  sessionUuid: string,
  beadPrefixes: string[],
  binaryPath: string,
  exec: Exec,
  extraPatterns: string[],
): Promise<string[]> {
  try {
    if (!SESSION_ID_SHAPE.test(sessionUuid)) return [];
    // Null pattern (no prefix survived revalidation) skips the pass before
    // any subprocess is spawned, same as an empty prefix list.
    const pattern = taskKeyPattern(beadPrefixes);
    if (!pattern) return [];
    const keys = new Set<string>();
    // Every candidate up to the cap is read (no early stop): engram watch
    // slices a session's tape per debounce, so mentions can live in any of
    // the top hits — see the MAX_KEY_TAPES ledger entry in tape.ts.
    for await (const { response } of grepPeekCandidates(
      sessionUuid, binaryPath, exec, MSG_FILTER, MAX_KEY_TAPES,
    )) {
      for (const event of tapeEvents(response)) {
        if (event.k !== "msg.in" && event.k !== "msg.out") continue;
        if (typeof event.content !== "string") continue;
        const source = event.source as Record<string, unknown> | undefined;
        if (source?.session_id !== sessionUuid) continue; // mention-only guard
        for (const key of event.content.match(pattern) ?? []) {
          // Fail-closed redaction backstop: a token a redact pattern would
          // alter is dropped rather than surfaced or marker-mangled.
          if (redact(key, extraPatterns) === key) keys.add(key);
        }
      }
    }
    return [...keys].sort();
  } catch {
    return [];
  }
}

// The task-key entry point for report generation: owns the enabled switch,
// the newest-first ordering, the probe-once dedupe, the default real exec
// seam, and the one fail-soft boundary — the discoverDispatchLinks contract,
// verbatim. Returns sessionId → sorted bead keys, entries only for sessions
// that yielded at least one key; disabled or failing engram returns an empty
// map, and TaskThread derivation degrades to file-cluster keys alone.
// Options shape matches corroborateSessions: redactPatterns is required so
// dropping the user's patterns is never a silent default.
export async function discoverTaskKeys(
  sessions: LineageSession[],
  cfg: EngramConfig,
  opts: CorroborateOptions,
): Promise<Map<string, string[]>> {
  const keysBySession = new Map<string, string[]>();
  // No configured prefixes = bead-key threading off: the whole pass (and its
  // per-session subprocess budget) is skipped, not just its matches.
  if (!cfg.enabled || cfg.beadPrefixes.length === 0) return keysBySession;
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
      const keys = await findTaskKeys(session.sessionId, cfg.beadPrefixes, cfg.binaryPath, realExec, opts.redactPatterns);
      if (keys.length > 0) keysBySession.set(session.sessionId, keys);
    }
    return keysBySession;
  } catch {
    return keysBySession;
  }
}
