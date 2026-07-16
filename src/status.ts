import type { AgentEvent, AgentProfile, CommitEvidence, EvidenceLevel, Severity, Status, Thresholds } from "./types";

const HOUR_MS = 3600_000;

// Severity is a pure function of status. Exported so renderers can color
// per-status UI (rollup chips) without re-deriving the mapping; exhaustive by
// construction — a new Status without a severity is a compile error.
export const STATUS_SEVERITY: Record<Status, Severity> = {
  failed: "urgent", silent: "urgent",
  blocked: "warning", needs_human: "warning",
  active: "info", idle: "info", completed: "info",
};

// Worst-first display ordering shared by the rollup line (src/render/rollup.ts)
// and TaskThread status rollup (src/threads.ts), defined once beside the
// sibling status semantics. Exhaustive by construction: adding a Status
// member without a display rank is a compile error, so new statuses can't
// silently vanish from either consumer.
export const STATUS_RANK: Record<Status, number> = {
  failed: 0, silent: 1, blocked: 2, needs_human: 3, active: 4, idle: 5, completed: 6,
};

// Statuses that demand attention (severity above info). Derived from
// STATUS_SEVERITY so a new Status can't silently miss the exception filter
// or the trend-streak set — one partition, defined once.
export const EXCEPTION_STATUSES: ReadonlySet<Status> = new Set(
  (Object.keys(STATUS_SEVERITY) as Status[]).filter((s) => STATUS_SEVERITY[s] !== "info"),
);

function lastOf(events: AgentEvent[], type: AgentEvent["type"]): AgentEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) if (events[i]!.type === type) return events[i];
  return undefined;
}

const TERMINAL_EVENT_TYPES = new Set(["completed", "failed", "blocked", "approval_requested"]);

// The newest session's own reading of the profile, or undefined to defer to
// the historical chain. A completed/artifact event anywhere in the profile's
// history must not mask the *newest* session's own state: if it is still open
// (no terminal event) and has produced no artifact of its own, it reports on
// its own timeline — recent events → active, long quiet → silent or idle. In
// the in-between range we defer, so an older completion still reads completed.
//
// Arbitration exceptions, in order:
// - Any open session that went dark mid-work keeps the profile silent — a
//   newer abandoned chat must not mask an older stuck one.
// - Delivered work beats an abandoned chat's idle reading: with in-window
//   artifacts or attributed commits we defer to the historical chain
//   (completed) instead of underreporting a profile that shipped (asl-290).
//   A claimed-only `completed` event deliberately does not qualify —
//   delivery is evidence, a claim is not.
function newestOpenReading(
  profile: AgentProfile,
  attributed: CommitEvidence[],
  hasArtifact: boolean,
  now: Date,
  t: Thresholds,
): Status | undefined {
  const newest = profile.sessions.reduce<(typeof profile.sessions)[number] | undefined>(
    (max, s) => (!max || s.startedAt > max.startedAt ? s : max),
    undefined,
  );
  if (newest === undefined) return undefined;
  if (newest.events.some((e) => TERMINAL_EVENT_TYPES.has(e.type))) return undefined;
  const hasCurrentArtifact =
    attributed.some((c) => Date.parse(c.authorDate) >= Date.parse(newest.startedAt)) ||
    newest.events.some((e) => e.type === "artifact_created");
  if (hasCurrentArtifact) return undefined;

  const idleMs = now.getTime() - Date.parse(newest.lastEventAt);
  if (idleMs <= t.activeWindowHours * HOUR_MS) return "active";
  if (idleMs < t.silentThresholdHours * HOUR_MS) return undefined;

  // An interactive session the human simply walked away from is a diary
  // entry, not an alarm; only an agent that went quiet mid-work is silent.
  const anyStuckOpen = profile.sessions.some(
    (s) =>
      !s.events.some((e) => TERMINAL_EVENT_TYPES.has(e.type)) &&
      now.getTime() - Date.parse(s.lastEventAt) >= t.silentThresholdHours * HOUR_MS &&
      s.awaitingUser !== true,
  );
  if (anyStuckOpen) return "silent";
  return hasArtifact ? undefined : "idle";
}

export function inferStatus(
  profile: AgentProfile,
  commits: CommitEvidence[],
  now: Date,
  t: Thresholds,
): { status: Status; severity: Severity; evidence: EvidenceLevel } {
  const events = profile.sessions.flatMap((s) => s.events).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const lastEventAt = profile.sessions.reduce((max, s) => (s.lastEventAt > max ? s.lastEventAt : max), "");
  const completed = lastOf(events, "completed");
  const after = (a: AgentEvent | undefined, b: AgentEvent | undefined) =>
    a !== undefined && (b === undefined || a.timestamp > b.timestamp);

  const approval = lastOf(events, "approval_requested");
  const failed = lastOf(events, "failed");
  const blocked = lastOf(events, "blocked");
  const attributed = commits.filter((c) => c.attributed);
  const hasArtifact = events.some((e) => e.type === "artifact_created") || attributed.length > 0;

  const newestOpenStatus = newestOpenReading(profile, attributed, hasArtifact, now, t);

  let status: Status;
  if (after(approval, completed)) status = "needs_human";
  else if (after(failed, completed)) status = "failed";
  else if (after(blocked, completed) && after(blocked, failed)) status = "blocked";
  else if (newestOpenStatus !== undefined) status = newestOpenStatus;
  else if (completed || hasArtifact) status = "completed";
  else {
    const idleMs = now.getTime() - Date.parse(lastEventAt);
    if (idleMs <= t.activeWindowHours * HOUR_MS) status = "active";
    else if (idleMs >= t.silentThresholdHours * HOUR_MS) status = "silent";
    else status = "idle";
  }

  const severity: Severity = STATUS_SEVERITY[status];

  const evidence: EvidenceLevel = hasArtifact
    ? "proven"
    : profile.sessions.some((s) => s.filesTouched.length > 0)
      ? "partially_proven"
      : "claimed_only";

  return { status, severity, evidence };
}
