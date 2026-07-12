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

function lastOf(events: AgentEvent[], type: AgentEvent["type"]): AgentEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) if (events[i]!.type === type) return events[i];
  return undefined;
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

  // A completed/artifact event anywhere in the profile's history must not mask the
  // *newest* session's own state. Find the newest session (by startedAt); if it is
  // still open (no terminal event of its own) and has produced no artifact of its
  // own (no attributed commit since it started, no artifact_created event), report
  // it on its own timeline: recent events → active, long quiet → silent. In the
  // in-between (idle-ish) range we fall through to the historical chain, where an
  // older completion still reads as completed.
  const TERMINAL_EVENT_TYPES = new Set(["completed", "failed", "blocked", "approval_requested"]);
  const newest = profile.sessions.reduce<(typeof profile.sessions)[number] | undefined>(
    (max, s) => (!max || s.startedAt > max.startedAt ? s : max),
    undefined,
  );
  const open = newest !== undefined && !newest.events.some((e) => TERMINAL_EVENT_TYPES.has(e.type));
  const hasCurrentArtifact =
    newest !== undefined &&
    (attributed.some((c) => Date.parse(c.authorDate) >= Date.parse(newest.startedAt)) ||
      newest.events.some((e) => e.type === "artifact_created"));
  let newestOpenStatus: Status | undefined;
  if (newest !== undefined && open && !hasCurrentArtifact) {
    const idleMs = now.getTime() - Date.parse(newest.lastEventAt);
    if (idleMs <= t.activeWindowHours * HOUR_MS) newestOpenStatus = "active";
    // An interactive session the human simply walked away from is a diary
    // entry, not an alarm; only an agent that went quiet mid-work is silent.
    else if (idleMs >= t.silentThresholdHours * HOUR_MS) {
      // Any open session that went dark mid-conversation keeps the profile
      // silent — a newer abandoned chat must not mask an older stuck one.
      const anyStuckOpen = profile.sessions.some(
        (s) =>
          !s.events.some((e) => TERMINAL_EVENT_TYPES.has(e.type)) &&
          now.getTime() - Date.parse(s.lastEventAt) >= t.silentThresholdHours * HOUR_MS &&
          s.awaitingUser !== true,
      );
      newestOpenStatus = anyStuckOpen ? "silent" : "idle";
    }
  }

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
