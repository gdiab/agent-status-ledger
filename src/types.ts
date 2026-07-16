export type Platform = "claude-code" | "codex";

export type EventType =
  | "run_started"
  | "run_progressed"
  | "artifact_created"
  | "approval_requested"
  | "blocked"
  | "failed"
  | "completed";

export type Status =
  | "active" | "idle" | "completed" | "blocked"
  | "failed" | "silent" | "needs_human";

export type EvidenceLevel = "proven" | "partially_proven" | "claimed_only" | "unknown";
export type Severity = "info" | "warning" | "urgent";

export interface AgentEvent {
  timestamp: string;        // ISO-8601 UTC
  type: EventType;
  summary: string;          // short, human-readable, no transcript text
}

export interface RawSession {
  platform: Platform;
  sessionId: string;
  cwd: string;
  startedAt: string;
  lastEventAt: string;
  title?: string;
  events: AgentEvent[];
  filesTouched: string[];
  errors: string[];         // first lines only
  // True iff the session's last meaningful event puts the ball in the human's
  // court (agent finished its reply). Absent = unknown = treated as false, so
  // unparseable logs still alert (silent) rather than silently demote.
  awaitingUser?: boolean;
  // True iff the session ends with agent work visibly in flight (dangling
  // tool call, unprocessed tool result, task or approval pending). A mid-work
  // session must never be filtered as trivial noise.
  midWork?: boolean;
}

export interface ScanOptions {
  since: Date;
  now: Date;
  rootDir: string;          // ~/.claude/projects or ~/.codex — injectable for tests
  // User-supplied redact regexes (config.redactPatterns). Required so no scan
  // call site can silently skip user redaction; connectors excerpt only via
  // makeClip(redactPatterns), which redacts before it truncates.
  redactPatterns: string[];
}

export interface AgentProfile {
  profileId: string;        // `${platform}:${cwd}`
  platform: Platform;
  workdir: string;
  displayName: string;      // `${basename(cwd)} (${platform})`
  sessions: RawSession[];   // sorted by startedAt ascending
}

export interface Commit {
  sha: string;
  authorDate: string;       // ISO-8601
  subject: string;
}

export interface CommitEvidence extends Commit {
  attributed: boolean;      // author time inside a run window
}

export interface FactSheet {
  titles: string[];
  filesTouched: string[];
  errors: string[];
  commits: string[];        // "abc1234 subject" — attributed only
  sessionCount: number;
  firstActivity: string;
  lastActivity: string;
}

export interface Narrative {
  workedOn: string;
  completed: string;
  inProgress: string;
  blocked: string;
  recommendation: string;
  standup: string;          // 2–4 sentences, first person, the agent speaking at standup
}

// One end of an orchestrator → subagent dispatch-marker link discovered by
// the Engram connector (src/connectors/engram.ts, discoverDispatchLinks):
// the other party's harness session uuid, plus its profile display name when
// that session belongs to a profile in this report window.
export interface DispatchRef {
  sessionId: string;
  profile?: string;
}

export interface AgentReport {
  profileId: string;
  displayName: string;
  platform: Platform;
  workdir: string;
  status: Status;
  severity: Severity;
  evidence: EvidenceLevel;
  // Human-readable citation for an evidence upgrade performed by an optional
  // enrichment connector (currently: Engram fingerprint corroboration —
  // src/connectors/engram.ts). Additive + optional, same precedent as
  // `trends?: string[]` below — schemaVersion stays 1. Absent unless a
  // connector actually upgraded this report's evidence.
  evidenceCitation?: string;
  facts: FactSheet;
  narrative: Narrative;
  narrativeSource: "llm" | "template";
  commits: CommitEvidence[];
  // Cross-day trend annotations diffed against the previous day's report
  // (src/trends.ts): status streaks, commit velocity, recurring errors.
  // Additive + optional, absent when empty or when no history exists —
  // schemaVersion stays 1 (same contract as Report.trivialProfiles).
  trends?: string[];
  // Engram dispatch-marker lineage (src/connectors/engram.ts): sessions of
  // this profile that were dispatched by another session's `<engram-src/>`
  // marker (dispatchedBy) and sessions this profile's runs dispatched
  // (dispatched). Additive + optional, absent when empty — schemaVersion
  // stays 1 (same contract as trends above).
  dispatchedBy?: DispatchRef[];
  dispatched?: DispatchRef[];
  // In-session subagent runs this profile's sessions dispatched with a
  // marker (Task-tool runs): the subagent transcript inherits the
  // dispatching session's harness session id, so the run is a genuine
  // dispatch with no session of its own to link — a count is the honest
  // representation. Additive + optional, absent when zero — schemaVersion
  // stays 1 (same contract as trends above).
  dispatchedRuns?: number;
  // True when the engram lineage probe found more marker-carrying tapes for
  // this profile's sessions than its per-parent cap allowed peeking, so
  // `dispatched`/`dispatchedRuns` may be an undercount. Renderers append
  // "(list may be incomplete)" to the dispatched line — grounded language
  // over false completeness. Additive + optional, absent when the walk was
  // exhaustive — schemaVersion stays 1 (same contract as trends above).
  dispatchTruncated?: true;
}

export interface Report {
  schemaVersion: 1;
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  exceptions: AgentReport[];  // status in blocked|failed|silent|needs_human
  agents: AgentReport[];      // all agents, exceptions included, sorted by severity then name
  // Display names of profiles hidden as noise (only sub-minSessionSeconds
  // sessions, nothing touched/produced/errored). Additive + optional:
  // schemaVersion stays 1. Absent when empty.
  trivialProfiles?: string[];
  // Report-level trend annotations (total commit velocity vs the previous
  // report). Additive + optional like trivialProfiles; absent when empty.
  trends?: string[];
}

export interface Thresholds {
  activeWindowHours: number;
  silentThresholdHours: number;
  minSessionSeconds: number;   // profiles with only shorter, artifact-free sessions are trivial
}
