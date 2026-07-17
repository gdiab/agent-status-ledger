// ── Dispatch-marker lineage (orchestrator → subagent runs) ──────────────────
//
// Engram's dispatch-marker convention (engram specs/core/dispatch-marker.md):
// the dispatching party prepends `<engram-src id="<uuid>"/>` to the handoff
// prompt, so the marker lands verbatim at the START of the dispatched agent's
// transcript. Engram's own chain traversal is only reachable through
// `explain <file/span/literal>` (grep emits a top-level `dispatch_lineage`
// key but always `[]`, and `explain --dispatch` was removed from the CLI),
// so ASL reconstructs the one hop it needs from the same two proven
// primitives the evidence upgrade uses — grep, then peek by tape id.
//
// The probe queries the marker LITERAL, not the parent uuid (asl-9pd). Live
// validation killed the parent-uuid grep: a session uuid matches hundreds
// of tapes (harness tool results embed session-scoped paths naming it, and
// engram watch emits per-debounce tape slices, so the parent's own slices
// flood the ranking), which meant genuine dispatch tapes lost the ranking
// race and every candidate cap truncated before reaching them. The marker
// literal is immune to both noise sources, because it is queried AS IT
// APPEARS IN A RAW TAPE LINE: tape events are JSON objects, so the marker
// inside a `content` string carries escaped quotes
// (`<engram-src id=\"<uuid>\"/>`), and grep is a literal substring search
// over raw lines. That shape is doubly selective:
//   - a tape matches only where the marker reached a content STRING — the
//     dispatched side's own transcript (its first inbound message starts
//     with the marker) or a transcript quoting the marker verbatim;
//   - the DISPATCHING side's own tape does NOT match: there the marker sits
//     inside a tool-call prompt argument, nested one JSON level deeper, so
//     its quotes are double-escaped in the raw line.
// So the uuid grep is noise-dominated while the marker-literal grep returns
// only dispatch tapes plus the rare verbatim quote (rejected by the event
// guards below). Deterministic, O(report sessions) greps, no ranking
// dependence.
//
// `engram peek <tape> --grep-filter <marker-literal>` then returns the tape
// lines carrying the marker (and their context). A parsed tape event mints
// lineage only when ALL of, on that same event:
//   - the event is an inbound message (k == "msg.in" — the dispatch prompt
//     arrives as the dispatched agent's incoming message; engram
//     specs/core/event-contract.md is the kind registry),
//   - its parsed `content` is a string that STARTS with the literal marker
//     `<engram-src id="<parent-uuid>"/>` (leading whitespace only) — the
//     spec says "The marker is prepended to the handoff message" (engram
//     specs/core/dispatch-marker.md), so a genuine dispatch always carries
//     it as a prefix; a marker quoted mid-conversation or mid-text never
//     matches — and
//   - its source.session_id classifies the dispatch:
//       - ANOTHER session known to this report → a cross-session link,
//         parent → child (the mention-only guard, inverted: here the
//         mention IS the evidence, but it must resolve to a session ASL
//         can name);
//       - the parent uuid ITSELF → an in-session subagent run: Claude Code
//         Task-tool subagent transcripts inherit the dispatching session's
//         sessionId, so engram records the run's events under the parent's
//         own uuid. A genuine dispatch with no harness session of its own —
//         counted per run (deduped by the inbound message's timestamp +
//         content, the closest thing to a per-run identity the tape
//         exposes; see findDispatches for the validation and the residual
//         precision limit) and attributed to the parent, never minted as a
//         self-link;
//       - anything else → a session outside the report window; skipped.
// Same-event correlation is load-bearing: a session merely QUOTING the
// marker in a msg.out/tool.result (code review, test fixture), or a peek
// response mixing an A-owned marker line with unrelated B-owned context
// lines, must not mint lineage.
//
// Same discipline as the evidence upgrade: never throws, allowlisted argv
// only, bounded subprocess budget, and consuming CLI JSON only (never the
// SQLite dispatch_links table — the DB schema has no stability contract).
import type { EngramConfig } from "../../config";
import { makeSpawnExec, type Exec } from "../../exec";
import {
  ENGRAM_TIMEOUT_MS, MAX_MARKER_TAPES, SESSION_ID_SHAPE, TAPE_TIMESTAMP_SHAPE,
  grepPeekCandidates, tapeEvents,
  type LineageSession,
} from "./tape";

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

// The marker as it appears in a RAW tape line (JSON-escaped quotes) — the
// grep query and peek filter for the lineage probe (see the pipeline
// comment above for why this shape, not the uuid, is what gets queried).
// Built only from a SESSION_ID_SHAPE-validated uuid, and it starts with
// '<', so it can never be mistaken for a CLI option.
function markerTapeLiteral(sessionUuid: string): string {
  return `<engram-src id=\\"${sessionUuid}\\"/>`;
}

export interface DispatchLink {
  parentSessionId: string; // orchestrator harness session uuid (the marker id)
  childSessionId: string;  // dispatched subagent harness session uuid
}

// Dispatches made BY `parentUuid`, resolved against the report's own
// session set (grep the marker literal, peek each marker-carrying tape,
// classify the inbound marker events — see the pipeline comment above for
// the same-event correlation rule). `children` are cross-session dispatch
// targets; `runCount` counts in-session subagent runs (marker events owned
// by the parent itself, deduped by inbound-message timestamp + content —
// engram exposes no run/event id, see the identity comment in the msg.in
// classification below). `truncated`
// is true when grep matched more marker tapes index-wide than
// MAX_MARKER_TAPES allowed peeking, i.e. the discovered lineage may be an
// undercount — surfaced so the report can say "list may be incomplete"
// rather than dropping the fact. Never throws.
export async function findDispatches(
  parentUuid: string,
  knownSessionIds: ReadonlySet<string>,
  binaryPath: string,
  exec: Exec,
): Promise<{ children: string[]; runCount: number; truncated: boolean }> {
  const nothing = { children: [], runCount: 0, truncated: false };
  try {
    if (!SESSION_ID_SHAPE.test(parentUuid)) return nothing;
    const literal = markerTapeLiteral(parentUuid);
    const marker = markerPrefixPattern(parentUuid);
    const children = new Set<string>();
    const runs = new Set<string>();
    const meta = { truncated: false };
    for await (const { response } of grepPeekCandidates(
      literal, binaryPath, exec, literal, MAX_MARKER_TAPES, meta,
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
        if (sid === parentUuid) {
          // In-session run identity: engram exposes no run or event id, so
          // the honest best discriminator the peeked msg.in carries is its
          // own timestamp plus its content (the full marker-prefixed
          // dispatch prompt). The same run's msg.in repeated across tape
          // slices carries both verbatim and counts once; two dispatches
          // recorded in the same instant still differ by prompt and count
          // separately. Residual precision limit, accepted: two dispatches
          // with an IDENTICAL prompt in the same recorded instant collapse
          // to one — nothing in the tape can tell them apart today. A
          // timestamp that fails the shape check (empty, garbage) can't
          // anchor an identity at all, so the event is skipped rather than
          // counted (risking slice overcount) or deduped on the junk
          // (collapsing distinct dispatches).
          // Shape alone admits impossible instants ("2026-99-99T…"), so the
          // value must also parse to a real date before anchoring identity.
          if (
            typeof event.t !== "string" ||
            !TAPE_TIMESTAMP_SHAPE.test(event.t) ||
            !Number.isFinite(Date.parse(event.t))
          )
            continue;
          runs.add(`${event.t}\u0000${event.content}`);
        } else if (knownSessionIds.has(sid)) {
          children.add(sid);
        }
      }
    }
    return { children: [...children].sort(), runCount: runs.size, truncated: meta.truncated };
  } catch {
    return nothing;
  }
}

// What the lineage walk hands back to report generation: the discovered
// cross-session edges, the in-session subagent run counts per dispatching
// parent (report.ts sums them onto the owning profile's card as
// AgentReport.dispatchedRuns), plus the parents whose candidate walk was
// truncated (their discovered lineage may be an undercount — report.ts
// turns each into AgentReport.dispatchTruncated on the owning profile's
// card).
export interface DispatchDiscovery {
  links: DispatchLink[];
  runsByParent: { parentSessionId: string; runCount: number }[]; // runCount > 0 only, in probe order
  truncatedParents: string[]; // parent session uuids, in probe order
}

const EMPTY_DISCOVERY: DispatchDiscovery = { links: [], runsByParent: [], truncatedParents: [] };

// The lineage entry point for report generation: owns the enabled switch,
// the newest-first ordering, the default real exec seam, and the one
// fail-soft boundary — the corroborateSessions contract, verbatim. Every
// session in the report window is probed as a candidate parent (see the
// budget block in tape.ts for why there is deliberately no session cap
// here); links only ever join two sessions the report already knows, and
// run counts only ever attach to a session the report already knows.
export async function discoverDispatchLinks(
  sessions: LineageSession[],
  cfg: EngramConfig,
  exec?: Exec,
): Promise<DispatchDiscovery> {
  if (!cfg.enabled) return EMPTY_DISCOVERY;
  try {
    const knownIds = new Set(
      sessions.map((s) => s.sessionId).filter((id) => SESSION_ID_SHAPE.test(id)),
    );
    // A cross-session link needs two known sessions, but an in-session
    // subagent run needs only its dispatching parent — so any usable
    // session at all is worth probing; only an empty set short-circuits.
    if (knownIds.size === 0) return EMPTY_DISCOVERY;
    const realExec = exec ?? makeSpawnExec(ENGRAM_TIMEOUT_MS);
    const newestFirst = [...sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const links: DispatchLink[] = [];
    const runsByParent: DispatchDiscovery["runsByParent"] = [];
    const truncatedParents: string[] = [];
    const seen = new Set<string>();
    // Probe each parent id ONCE, even when the window carries it several
    // times (Task-tool subagent transcripts inherit the dispatching
    // session's sessionId, and profile resolution doesn't dedupe sessions).
    // A duplicate would re-run the same grep AND mint a second identical
    // runsByParent entry, which report.ts sums — doubling dispatchedRuns.
    const probed = new Set<string>();
    for (const session of newestFirst) {
      if (!knownIds.has(session.sessionId) || probed.has(session.sessionId)) continue;
      probed.add(session.sessionId);
      const { children, runCount, truncated } = await findDispatches(session.sessionId, knownIds, cfg.binaryPath, realExec);
      if (truncated) truncatedParents.push(session.sessionId);
      if (runCount > 0) runsByParent.push({ parentSessionId: session.sessionId, runCount });
      for (const child of children) {
        const key = `${session.sessionId}\u0000${child}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({ parentSessionId: session.sessionId, childSessionId: child });
      }
    }
    return { links, runsByParent, truncatedParents };
  } catch {
    return EMPTY_DISCOVERY;
  }
}
