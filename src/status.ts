import type { AgentEvent, AgentProfile, CommitEvidence, EvidenceLevel, Severity, Status, Thresholds } from "./types";

const HOUR_MS = 3600_000;

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

  let status: Status;
  if (after(approval, completed)) status = "needs_human";
  else if (after(failed, completed)) status = "failed";
  else if (after(blocked, completed) && after(blocked, failed)) status = "blocked";
  else if (completed || hasArtifact) status = "completed";
  else {
    const idleMs = now.getTime() - Date.parse(lastEventAt);
    if (idleMs <= t.activeWindowHours * HOUR_MS) status = "active";
    else if (idleMs >= t.silentThresholdHours * HOUR_MS) status = "silent";
    else status = "idle";
  }

  const severity: Severity =
    status === "failed" || status === "silent" ? "urgent"
    : status === "blocked" || status === "needs_human" ? "warning"
    : "info";

  const evidence: EvidenceLevel = hasArtifact
    ? "proven"
    : profile.sessions.some((s) => s.filesTouched.length > 0)
      ? "partially_proven"
      : "claimed_only";

  return { status, severity, evidence };
}
