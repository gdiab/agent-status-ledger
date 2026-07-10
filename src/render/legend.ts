import type { EvidenceLevel, Severity, Status } from "../types";

// Single source of truth for status/evidence/severity copy — both renderers
// import these, so the hover tooltips and the legend can never drift apart.
// Record<Status, string> is exhaustive by construction: a new Status member
// without help text is a compile error.
export const STATUS_HELP: Record<Status, string> = {
  active: "Activity within the active window — working right now.",
  idle: "Open session gone quiet with the ball in your court — no action needed.",
  completed: "Finished its work, or produced durable artifacts (commits).",
  blocked: "The agent reported it cannot proceed.",
  failed: "The last run ended in an error.",
  silent: "Left open mid-work and quiet past the silent threshold — check whether it is stuck.",
  needs_human: "An approval or decision is waiting on you.",
};

export const EVIDENCE_HELP: Record<EvidenceLevel, string> = {
  proven: "Commits or artifacts back this up.",
  partially_proven: "Files were touched, but nothing durable was produced.",
  claimed_only: "Only the session log claims this — no artifacts found.",
  unknown: "Not enough information to judge.",
};

export const SEVERITY_HELP: Record<Severity, string> = {
  urgent: "Needs your attention now.",
  warning: "Worth a look today.",
  info: "No action needed.",
};
