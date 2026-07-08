import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClaudeSession, scanClaudeCode } from "../src/connectors/claude-code";

const completed = readFileSync("fixtures/claude-code/session-completed.jsonl", "utf8");
const errored = readFileSync("fixtures/claude-code/session-error.jsonl", "utf8");

describe("parseClaudeSession", () => {
  test("extracts cwd, title, window, files, progress events", () => {
    const s = parseClaudeSession(completed, "/fallback")!;
    expect(s.platform).toBe("claude-code");
    expect(s.sessionId).toBe("cc-fix-1");
    expect(s.cwd).toBe("/work/demo");           // from entries, not fallback
    expect(s.title).toBe("Fix login bug");
    expect(s.startedAt).toBe("2026-07-07T09:00:00.000Z");
    expect(s.lastEventAt).toBe("2026-07-07T09:30:00.000Z");
    expect(s.filesTouched).toEqual(["/work/demo/src/login.ts"]);
    expect(s.events[0]!.type).toBe("run_started");
    expect(s.events.filter((e) => e.type === "run_progressed").length).toBe(3);
    expect(s.errors).toEqual([]);
  });

  test("session ending on a tool error emits failed event with first line only", () => {
    const s = parseClaudeSession(errored, "/fallback")!;
    expect(s.errors).toEqual(["Error: missing AWS credentials"]);
    expect(s.events.at(-1)!.type).toBe("failed");
    expect(s.events.at(-1)!.summary).toBe("Error: missing AWS credentials");
  });

  test("mid-session tool error does NOT mark session failed", () => {
    const recovered = errored +
      '\n{"type":"assistant","timestamp":"2026-07-07T10:05:00.000Z","cwd":"/work/broken","sessionId":"cc-err-1","message":{"role":"assistant","content":[{"type":"text","text":"Retried with creds, done."}]}}';
    const s = parseClaudeSession(recovered, "/fallback")!;
    expect(s.errors.length).toBe(1);
    expect(s.events.at(-1)!.type).not.toBe("failed");
  });

  test("garbage lines are skipped, empty session returns null", () => {
    expect(parseClaudeSession("not json\n{\"broken\":", "/x")).toBeNull();
  });
});

describe("scanClaudeCode", () => {
  test("scans only files modified in window, uses dir name as fallback cwd", async () => {
    const root = mkdtempSync(join(tmpdir(), "asl-cc-"));
    const proj = join(root, "-work-demo");
    mkdirSync(proj);
    writeFileSync(join(proj, "a.jsonl"), completed);
    writeFileSync(join(proj, "skip.txt"), "ignore me");
    const now = new Date("2026-07-08T09:00:00.000Z");
    const sessions = await scanClaudeCode({ since: new Date(now.getTime() - 86_400_000), now, rootDir: root });
    expect(sessions.length).toBe(1);
    expect(sessions[0]!.cwd).toBe("/work/demo");
    // out-of-window: since in the future relative to file mtimes
    const none = await scanClaudeCode({ since: new Date(now.getTime() + 86_400_000), now, rootDir: root });
    expect(none.length).toBe(0);
  });

  test("missing rootDir returns empty, does not throw", async () => {
    const sessions = await scanClaudeCode({ since: new Date(), now: new Date(), rootDir: "/nope/nothing" });
    expect(sessions).toEqual([]);
  });
});
