import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
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

  test("errors carry the in-flight tool context", () => {
    const line = (o: unknown) => JSON.stringify(o);
    const text = [
      line({ sessionId: "s", type: "assistant", timestamp: "2026-07-07T10:00:00Z", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "xcrun simctl list devices" } }] } }),
      line({ sessionId: "s", type: "user", timestamp: "2026-07-07T10:00:30Z", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "exit code 143" }] } }),
    ].join("\n");
    const s = parseClaudeSession(text, "/w")!;
    expect(s.errors[0]).toBe('exit code 143 — while Bash: {"command":"xcrun simctl list devices"}');
  });

  test("errors without a matching tool_use stay bare", () => {
    const line = (o: unknown) => JSON.stringify(o);
    const text = line({ sessionId: "s", type: "user", timestamp: "2026-07-07T10:00:30Z", message: { content: [{ type: "tool_result", tool_use_id: "missing", is_error: true, content: "boom" }] } });
    expect(parseClaudeSession(text, "/w")!.errors[0]).toBe("boom");
  });

  test("garbage lines are skipped, empty session returns null", () => {
    expect(parseClaudeSession("not json\n{\"broken\":", "/x")).toBeNull();
  });

  describe("awaitingUser", () => {
    const line = (o: unknown) => JSON.stringify(o);

    test("true when log ends with a plain assistant reply", () => {
      const text = [
        line({ sessionId: "s", type: "user", timestamp: "2026-07-07T10:00:00Z", message: { content: [{ type: "text", text: "do it" }] } }),
        line({ sessionId: "s", type: "assistant", timestamp: "2026-07-07T10:01:00Z", message: { content: [{ type: "text", text: "done" }] } }),
      ].join("\n");
      expect(parseClaudeSession(text, "/w")!.awaitingUser).toBe(true);
    });

    test("false when log ends with a dangling tool_use", () => {
      const text = [
        line({ sessionId: "s", type: "user", timestamp: "2026-07-07T10:00:00Z", message: { content: [{ type: "text", text: "do it" }] } }),
        line({ sessionId: "s", type: "assistant", timestamp: "2026-07-07T10:01:00Z", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 999" } }] } }),
      ].join("\n");
      expect(parseClaudeSession(text, "/w")!.awaitingUser).toBe(false);
    });

    test("false when log ends with an unanswered user message", () => {
      const text = [
        line({ sessionId: "s", type: "assistant", timestamp: "2026-07-07T10:00:00Z", message: { content: [{ type: "text", text: "hi" }] } }),
        line({ sessionId: "s", type: "user", timestamp: "2026-07-07T10:01:00Z", message: { content: [{ type: "text", text: "now do this" }] } }),
      ].join("\n");
      expect(parseClaudeSession(text, "/w")!.awaitingUser).toBe(false);
    });

    test("trailing non-turn entries do not change the flag", () => {
      const text = [
        line({ sessionId: "s", type: "assistant", timestamp: "2026-07-07T10:00:00Z", message: { content: [{ type: "text", text: "done" }] } }),
        line({ sessionId: "s", type: "file-history-snapshot", timestamp: "2026-07-07T10:00:01Z", snapshot: { trackedFileBackups: {} } }),
      ].join("\n");
      expect(parseClaudeSession(text, "/w")!.awaitingUser).toBe(true);
    });
  });

  describe("midWork", () => {
    const line = (o: unknown) => JSON.stringify(o);

    test("true when log ends with a dangling tool_use", () => {
      const text = [
        line({ sessionId: "s", type: "user", timestamp: "2026-07-07T10:00:00Z", message: { content: [{ type: "text", text: "do it" }] } }),
        line({ sessionId: "s", type: "assistant", timestamp: "2026-07-07T10:01:00Z", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 999" } }] } }),
      ].join("\n");
      expect(parseClaudeSession(text, "/w")!.midWork).toBe(true);
    });

    test("false when log ends with a plain assistant reply", () => {
      const text = [
        line({ sessionId: "s", type: "user", timestamp: "2026-07-07T10:00:00Z", message: { content: [{ type: "text", text: "do it" }] } }),
        line({ sessionId: "s", type: "assistant", timestamp: "2026-07-07T10:01:00Z", message: { content: [{ type: "text", text: "done" }] } }),
      ].join("\n");
      expect(parseClaudeSession(text, "/w")!.midWork).toBe(false);
    });

    test("false when log ends with a plain, unanswered user message", () => {
      const text = [
        line({ sessionId: "s", type: "assistant", timestamp: "2026-07-07T10:00:00Z", message: { content: [{ type: "text", text: "hi" }] } }),
        line({ sessionId: "s", type: "user", timestamp: "2026-07-07T10:01:00Z", message: { content: [{ type: "text", text: "now do this" }] } }),
      ].join("\n");
      expect(parseClaudeSession(text, "/w")!.midWork).toBe(false);
    });

    test("true when log ends with a trailing tool_result user message (result awaiting processing)", () => {
      const text = [
        line({ sessionId: "s", type: "assistant", timestamp: "2026-07-07T10:00:00Z", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } }),
        line({ sessionId: "s", type: "user", timestamp: "2026-07-07T10:00:30Z", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "a.ts" }] } }),
      ].join("\n");
      expect(parseClaudeSession(text, "/w")!.midWork).toBe(true);
    });
  });

  describe("timestamp-less trailing turn entries", () => {
    const line = (o: unknown) => JSON.stringify(o);

    test("a timestamp-less trailing user entry still updates awaitingUser", () => {
      const text = [
        line({ sessionId: "s", type: "assistant", timestamp: "2026-07-07T10:00:00Z", message: { content: [{ type: "text", text: "done" }] } }),
        line({ sessionId: "s", type: "user", message: { content: [{ type: "text", text: "one more thing" }] } }),
      ].join("\n");
      const s = parseClaudeSession(text, "/w")!;
      expect(s.awaitingUser).toBe(false);
      // lastEventAt must still reflect the last *timestamped* entry, since the
      // trailing entry itself carries no timestamp to record.
      expect(s.lastEventAt).toBe("2026-07-07T10:00:00.000Z");
    });
  });
});

describe("scanClaudeCode", () => {
  test("scans only files modified in window, uses dir name as fallback cwd", async () => {
    const root = mkdtempSync(join(tmpdir(), "asl-cc-"));
    const proj = join(root, "-work-demo");
    mkdirSync(proj);
    writeFileSync(join(proj, "a.jsonl"), completed);
    const d = new Date("2026-07-07T12:00:00.000Z");
    utimesSync(join(proj, "a.jsonl"), d, d);
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
