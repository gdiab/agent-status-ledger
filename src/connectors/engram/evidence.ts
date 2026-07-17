// Evidence-upgrade pass: optional, fail-soft enrichment that corroborates a
// claimed_only completion claim against Engram's own independently-parsed
// transcript tapes, upgrading evidence to partially_proven when Engram
// observed real code edits in that session. Never a hard dependency — every
// function here returns a "no match"/failure value instead of throwing,
// mirroring email.ts's never-throws contract. Query shape, budgets, and the
// redaction choke point live in tape.ts (the shared spine).
import type { EngramConfig } from "../../config";
import { makeSpawnExec, type Exec } from "../../exec";
import type { RawSession } from "../../types";
import {
  ENGRAM_TIMEOUT_MS, MAX_GREP_CANDIDATES, MAX_SESSIONS_PER_PROFILE, SESSION_ID_SHAPE,
  grepPeekCandidates, sanitizeTapeText, tapeEvents,
  type CorroborateOptions, type SanitizedTapeText,
} from "./tape";

const CODE_EDIT_FILTER = '"k":"code.edit"';
// Human-readable citation stays a one-liner: cap the distinct files named.
const MAX_CITED_FILES = 5;

export interface UpgradeResult {
  matched: boolean;
  // Branded: accidentally constructing an UpgradeResult with a raw
  // (unsanitized) string here is a compile error — see the honest scope of
  // that guarantee on SanitizedTapeText in tape.ts.
  citation?: SanitizedTapeText;
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
// code.edit events and verify their source.session_id). Async end to end —
// every subprocess call is awaited through the Exec seam, never
// event-loop-blocking (asl-e2q). Never throws. extraPatterns is required
// for the same reason as sanitizeTapeText's: dropping the user's
// redactPatterns must never be a silent default.
export async function upgradeEvidence(
  sessionUuid: string,
  binaryPath: string,
  exec: Exec,
  extraPatterns: string[],
): Promise<UpgradeResult> {
  try {
    // The uuid is the grep query verbatim; reject hostile shapes before any
    // exec (grepPeekCandidates trusts its caller to have validated).
    if (!SESSION_ID_SHAPE.test(sessionUuid)) return { matched: false };
    for await (const { engramSid, response } of grepPeekCandidates(
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

// The evidence-upgrade entry point for report generation: owns the enabled
// switch, the newest-first session ordering, both query budgets, the default
// real (timeout-bounded) exec seam, and the one fail-soft boundary —
// mirroring sendReportEmail's never-throws contract (asl-533). Callers gate
// on evidence level; everything engram-shaped lives here.
//
// The options object is required and redactPatterns has no default: the
// user's config.redactPatterns must be threaded through explicitly, so a
// call site that opts out ([]) is visible as configuration, never an
// accidental omission (see CorroborateOptions in tape.ts).
export async function corroborateSessions(
  sessions: RawSession[],
  cfg: EngramConfig,
  opts: CorroborateOptions,
): Promise<UpgradeResult> {
  if (!cfg.enabled) return { matched: false };
  try {
    // enabled=true with no injected seam runs the real binary (same pattern
    // as narrative.ts's `fetchFn ?? fetch`); tests inject fakes.
    const realExec = opts.exec ?? makeSpawnExec(ENGRAM_TIMEOUT_MS);
    const newestFirst = [...sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    for (const session of newestFirst.slice(0, MAX_SESSIONS_PER_PROFILE)) {
      const result = await upgradeEvidence(session.sessionId, cfg.binaryPath, realExec, opts.redactPatterns);
      if (result.matched) return result;
    }
    return { matched: false };
  } catch {
    return { matched: false };
  }
}
