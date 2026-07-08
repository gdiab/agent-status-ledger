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
}

export interface ScanOptions {
  since: Date;
  now: Date;
  rootDir: string;          // ~/.claude/projects or ~/.codex — injectable for tests
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
}

export interface AgentReport {
  profileId: string;
  displayName: string;
  platform: Platform;
  workdir: string;
  status: Status;
  severity: Severity;
  evidence: EvidenceLevel;
  facts: FactSheet;
  narrative: Narrative;
  narrativeSource: "llm" | "template";
  commits: CommitEvidence[];
}

export interface Report {
  schemaVersion: 1;
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  exceptions: AgentReport[];  // status in blocked|failed|silent|needs_human
  agents: AgentReport[];      // all agents, exceptions included, sorted by severity then name
}

export interface Thresholds {
  activeWindowHours: number;
  silentThresholdHours: number;
}
