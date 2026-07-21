import { describe, expect, test } from "bun:test";
import { dayKey, toUtcIso } from "../src/time";
import { parseClaudeSession } from "../src/connectors/claude-code";
import { parseCodexSession } from "../src/connectors/codex";

describe("toUtcIso", () => {
  test("converts offset timestamps to UTC Z form", () => {
    expect(toUtcIso("2026-07-08T09:00:00+02:00")).toBe("2026-07-08T07:00:00.000Z");
    expect(toUtcIso("2026-07-08T09:23:45-07:00")).toBe("2026-07-08T16:23:45.000Z");
  });

  test("passes UTC timestamps through unchanged", () => {
    expect(toUtcIso("2026-07-08T07:00:00.000Z")).toBe("2026-07-08T07:00:00.000Z");
  });

  test("treats zone-less timestamps as UTC, independent of host timezone", () => {
    expect(toUtcIso("2026-07-08T09:00:00")).toBe("2026-07-08T09:00:00.000Z");
    expect(toUtcIso("2026-07-08T09:00:00.500")).toBe("2026-07-08T09:00:00.500Z");
  });

  test("returns undefined for unparseable input", () => {
    expect(toUtcIso("not a date")).toBeUndefined();
    expect(toUtcIso("")).toBeUndefined();
  });
});

describe("dayKey", () => {
  test("returns the UTC YYYY-MM-DD day", () => {
    expect(dayKey(new Date("2026-07-20T12:00:00Z"))).toBe("2026-07-20");
    expect(dayKey(new Date("2026-07-20T23:30:00-05:00"))).toBe("2026-07-21"); // UTC day, not local
  });
});

describe("connector timestamp normalization", () => {
  test("claude-code session with offset timestamps normalizes to UTC", () => {
    // +02:00 entry is chronologically EARLIER than the Z entry despite
    // sorting later as a string — the bug this normalization fixes.
    const lines = [
      JSON.stringify({ sessionId: "s1", type: "user", timestamp: "2026-07-08T09:00:00+02:00", message: { content: [] } }),
      JSON.stringify({ sessionId: "s1", type: "assistant", timestamp: "2026-07-08T08:00:00Z", message: { content: [] } }),
    ].join("\n");
    const s = parseClaudeSession(lines, "/x")!;
    expect(s.startedAt).toBe("2026-07-08T07:00:00.000Z");
    expect(s.lastEventAt).toBe("2026-07-08T08:00:00.000Z");
    for (const e of s.events) expect(e.timestamp).toEndWith("Z");
  });

  test("codex session with offset timestamps normalizes to UTC", () => {
    const lines = [
      JSON.stringify({ type: "session_meta", timestamp: "2026-07-08T09:00:00+02:00", payload: { id: "c1", cwd: "/w" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-07-08T08:00:00Z", payload: { type: "task_started" } }),
    ].join("\n");
    const s = parseCodexSession(lines, new Map())!;
    expect(s.startedAt).toBe("2026-07-08T07:00:00.000Z");
    expect(s.lastEventAt).toBe("2026-07-08T08:00:00.000Z");
  });
});
