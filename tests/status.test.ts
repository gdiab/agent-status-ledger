import { describe, expect, test } from "bun:test";
import type { AgentEvent, AgentProfile, CommitEvidence, EventType } from "../src/types";
import { inferStatus } from "../src/status";

const T = { activeWindowHours: 2, silentThresholdHours: 6 };
const NOW = new Date("2026-07-07T20:00:00.000Z");

function profileWith(events: Array<[string, EventType]>, filesTouched: string[] = []): AgentProfile {
  const evs: AgentEvent[] = events.map(([timestamp, type]) => ({ timestamp, type, summary: type }));
  return {
    profileId: "claude-code:/w", platform: "claude-code", workdir: "/w", displayName: "w (claude-code)",
    sessions: [{
      platform: "claude-code", sessionId: "s1", cwd: "/w",
      startedAt: evs[0]!.timestamp, lastEventAt: evs.at(-1)!.timestamp,
      events: evs, filesTouched, errors: [],
    }],
  };
}

const commit = (attributed: boolean): CommitEvidence =>
  ({ sha: "a".repeat(40), authorDate: "2026-07-07T10:00:00.000Z", subject: "x", attributed });

describe("inferStatus", () => {
  test("approval with no later completion → needs_human / warning", () => {
    const r = inferStatus(profileWith([["2026-07-07T10:00:00.000Z", "run_started"], ["2026-07-07T10:05:00.000Z", "approval_requested"]]), [], NOW, T);
    expect(r.status).toBe("needs_human");
    expect(r.severity).toBe("warning");
  });

  test("failed with no later completion → failed / urgent", () => {
    const r = inferStatus(profileWith([["2026-07-07T10:00:00.000Z", "run_started"], ["2026-07-07T10:05:00.000Z", "failed"]]), [], NOW, T);
    expect(r.status).toBe("failed");
    expect(r.severity).toBe("urgent");
  });

  test("failed then completed later → completed", () => {
    const r = inferStatus(profileWith([
      ["2026-07-07T10:00:00.000Z", "failed"],
      ["2026-07-07T10:30:00.000Z", "completed"],
    ]), [], NOW, T);
    expect(r.status).toBe("completed");
    expect(r.severity).toBe("info");
  });

  test("attributed commit alone → completed and proven", () => {
    const r = inferStatus(profileWith([["2026-07-07T10:00:00.000Z", "run_progressed"]]), [commit(true)], NOW, T);
    expect(r.status).toBe("completed");
    expect(r.evidence).toBe("proven");
  });

  test("unattributed commit is NOT evidence", () => {
    const r = inferStatus(profileWith([["2026-07-07T10:00:00.000Z", "run_progressed"]]), [commit(false)], NOW, T);
    expect(r.status).not.toBe("completed");
    expect(r.evidence).toBe("claimed_only");
  });

  test("recent progress → active", () => {
    const r = inferStatus(profileWith([["2026-07-07T19:30:00.000Z", "run_progressed"]]), [], NOW, T);
    expect(r.status).toBe("active");
  });

  test("no events for 8h, nothing terminal → silent / urgent", () => {
    const r = inferStatus(profileWith([["2026-07-07T12:00:00.000Z", "run_progressed"]]), [], NOW, T);
    expect(r.status).toBe("silent");
    expect(r.severity).toBe("urgent");
  });

  test("no events for 3h → idle", () => {
    const r = inferStatus(profileWith([["2026-07-07T17:00:00.000Z", "run_progressed"]]), [], NOW, T);
    expect(r.status).toBe("idle");
  });

  test("files touched without artifact → partially_proven", () => {
    const r = inferStatus(profileWith([["2026-07-07T19:30:00.000Z", "run_progressed"]], ["/w/a.ts"]), [], NOW, T);
    expect(r.evidence).toBe("partially_proven");
  });
});
