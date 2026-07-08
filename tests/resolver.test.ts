import { describe, expect, test } from "bun:test";
import type { RawSession } from "../src/types";
import { resolveProfiles } from "../src/resolver";

function session(platform: "claude-code" | "codex", cwd: string, startedAt: string): RawSession {
  return {
    platform, cwd, startedAt,
    sessionId: `${platform}-${startedAt}`,
    lastEventAt: startedAt,
    events: [{ timestamp: startedAt, type: "run_started", summary: "s" }],
    filesTouched: [], errors: [],
  };
}

describe("resolveProfiles", () => {
  test("groups by platform:cwd, sorts sessions and profiles", () => {
    const profiles = resolveProfiles([
      session("claude-code", "/work/demo", "2026-07-07T10:00:00.000Z"),
      session("claude-code", "/work/demo", "2026-07-07T08:00:00.000Z"),
      session("codex", "/work/demo", "2026-07-07T09:00:00.000Z"),
      session("claude-code", "/work/other", "2026-07-07T09:00:00.000Z"),
    ]);
    expect(profiles.map((p) => p.profileId)).toEqual([
      "claude-code:/work/demo",
      "claude-code:/work/other",
      "codex:/work/demo",
    ]);
    const demo = profiles[0]!;
    expect(demo.sessions.map((s) => s.startedAt)).toEqual([
      "2026-07-07T08:00:00.000Z",
      "2026-07-07T10:00:00.000Z",
    ]);
    expect(demo.displayName).toBe("demo (claude-code)");
    expect(demo.workdir).toBe("/work/demo");
  });

  test("same cwd different platform stays separate", () => {
    const profiles = resolveProfiles([
      session("claude-code", "/w", "2026-07-07T08:00:00.000Z"),
      session("codex", "/w", "2026-07-07T08:00:00.000Z"),
    ]);
    expect(profiles.length).toBe(2);
  });
});
