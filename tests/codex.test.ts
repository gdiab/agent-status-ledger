import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCodexSession, scanCodex } from "../src/connectors/codex";

const completed = readFileSync("fixtures/codex/rollout-completed.jsonl", "utf8");
const approval = readFileSync("fixtures/codex/rollout-approval.jsonl", "utf8");
const titles = new Map([
  ["cx-blog-1", "Write launch blog post"],
  ["cx-deploy-1", "Terraform deploy"],
]);

describe("parseCodexSession", () => {
  test("completed session: meta, title, completed event", () => {
    const s = parseCodexSession(completed, titles)!;
    expect(s.platform).toBe("codex");
    expect(s.sessionId).toBe("cx-blog-1");
    expect(s.cwd).toBe("/work/blog");
    expect(s.title).toBe("Write launch blog post");
    expect(s.startedAt).toBe("2026-07-07T11:00:00.000Z");
    expect(s.lastEventAt).toBe("2026-07-07T11:40:01.000Z");
    expect(s.events.some((e) => e.type === "completed")).toBe(true);
  });

  test("approval session emits approval_requested", () => {
    const s = parseCodexSession(approval, titles)!;
    expect(s.events.at(-1)!.type).toBe("approval_requested");
    expect(s.events.at(-1)!.summary).toContain("terraform apply");
  });

  test("no session_meta and no timestamps returns null", () => {
    expect(parseCodexSession("garbage\n", titles)).toBeNull();
  });

  test("errors carry the in-flight exec command", () => {
    const line = (o: unknown) => JSON.stringify(o);
    const text = [
      line({ type: "session_meta", timestamp: "2026-07-07T10:00:00Z", payload: { id: "c1", cwd: "/w" } }),
      line({ type: "event_msg", timestamp: "2026-07-07T10:01:00Z", payload: { type: "exec_command_begin", command: ["npm", "run", "build"] } }),
      line({ type: "event_msg", timestamp: "2026-07-07T10:02:00Z", payload: { type: "error", message: "build failed" } }),
    ].join("\n");
    expect(parseCodexSession(text, new Map())!.errors[0]).toBe("build failed — while exec: npm run build");
  });

  test("a finished exec command is not blamed for a later error", () => {
    const line = (o: unknown) => JSON.stringify(o);
    const text = [
      line({ type: "session_meta", timestamp: "2026-07-07T10:00:00Z", payload: { id: "c1", cwd: "/w" } }),
      line({ type: "event_msg", timestamp: "2026-07-07T10:01:00Z", payload: { type: "exec_command_begin", command: "ls" } }),
      line({ type: "event_msg", timestamp: "2026-07-07T10:01:05Z", payload: { type: "exec_command_end" } }),
      line({ type: "event_msg", timestamp: "2026-07-07T10:02:00Z", payload: { type: "stream_error", message: "connection reset" } }),
    ].join("\n");
    expect(parseCodexSession(text, new Map())!.errors[0]).toBe("connection reset");
  });

  describe("awaitingUser", () => {
    const line = (o: unknown) => JSON.stringify(o);
    const meta = line({ type: "session_meta", timestamp: "2026-07-07T10:00:00Z", payload: { id: "c1", cwd: "/w" } });
    const parse = (rest: string[]) => parseCodexSession([meta, ...rest].join("\n"), new Map())!;

    test("true when last event is agent_message", () => {
      expect(parse([
        line({ type: "event_msg", timestamp: "2026-07-07T10:01:00Z", payload: { type: "task_started" } }),
        line({ type: "event_msg", timestamp: "2026-07-07T10:02:00Z", payload: { type: "agent_message" } }),
      ]).awaitingUser).toBe(true);
    });

    test("true when last event is task_complete", () => {
      expect(parse([
        line({ type: "event_msg", timestamp: "2026-07-07T10:02:00Z", payload: { type: "task_complete", last_agent_message: "done" } }),
      ]).awaitingUser).toBe(true);
    });

    test("false when last event is task_started (mid-work)", () => {
      expect(parse([
        line({ type: "event_msg", timestamp: "2026-07-07T10:01:00Z", payload: { type: "agent_message" } }),
        line({ type: "event_msg", timestamp: "2026-07-07T10:02:00Z", payload: { type: "task_started" } }),
      ]).awaitingUser).toBe(false);
    });

    test("trailing unknown event types do not change the flag", () => {
      expect(parse([
        line({ type: "event_msg", timestamp: "2026-07-07T10:02:00Z", payload: { type: "agent_message" } }),
        line({ type: "event_msg", timestamp: "2026-07-07T10:02:01Z", payload: { type: "token_count" } }),
      ]).awaitingUser).toBe(true);
    });

    test("false when a dangling exec_command_begin trails agent_message (no matching end)", () => {
      expect(parse([
        line({ type: "event_msg", timestamp: "2026-07-07T10:01:00Z", payload: { type: "task_started" } }),
        line({ type: "event_msg", timestamp: "2026-07-07T10:02:00Z", payload: { type: "agent_message" } }),
        line({ type: "event_msg", timestamp: "2026-07-07T10:03:00Z", payload: { type: "exec_command_begin", command: "ls" } }),
      ]).awaitingUser).toBe(false);
    });

    test("false when exec_command_begin is followed by exec_command_end (agent still owes processing)", () => {
      expect(parse([
        line({ type: "event_msg", timestamp: "2026-07-07T10:01:00Z", payload: { type: "task_started" } }),
        line({ type: "event_msg", timestamp: "2026-07-07T10:02:00Z", payload: { type: "agent_message" } }),
        line({ type: "event_msg", timestamp: "2026-07-07T10:03:00Z", payload: { type: "exec_command_begin", command: "ls" } }),
        line({ type: "event_msg", timestamp: "2026-07-07T10:03:05Z", payload: { type: "exec_command_end" } }),
      ]).awaitingUser).toBe(false);
    });
  });

  describe("midWork", () => {
    const line = (o: unknown) => JSON.stringify(o);
    const meta = line({ type: "session_meta", timestamp: "2026-07-07T10:00:00Z", payload: { id: "c1", cwd: "/w" } });
    const parse = (rest: string[]) => parseCodexSession([meta, ...rest].join("\n"), new Map())!;

    test("true when the log ends with a trailing task_started", () => {
      expect(parse([
        line({ type: "event_msg", timestamp: "2026-07-07T10:01:00Z", payload: { type: "task_started" } }),
      ]).midWork).toBe(true);
    });

    test("false when the log ends with task_complete", () => {
      expect(parse([
        line({ type: "event_msg", timestamp: "2026-07-07T10:01:00Z", payload: { type: "task_started" } }),
        line({ type: "event_msg", timestamp: "2026-07-07T10:02:00Z", payload: { type: "task_complete", last_agent_message: "done" } }),
      ]).midWork).toBe(false);
    });

    test("true when the log ends with a trailing exec_approval_request", () => {
      expect(parse([
        line({ type: "event_msg", timestamp: "2026-07-07T10:01:00Z", payload: { type: "task_started" } }),
        line({ type: "event_msg", timestamp: "2026-07-07T10:02:00Z", payload: { type: "exec_approval_request", command: "terraform apply" } }),
      ]).midWork).toBe(true);
    });
  });
});

describe("scanCodex", () => {
  test("walks date dirs inside window and applies index titles", async () => {
    const root = mkdtempSync(join(tmpdir(), "asl-cx-"));
    const day = join(root, "sessions", "2026", "07", "07");
    mkdirSync(day, { recursive: true });
    const filePath = join(day, "rollout-2026-07-07T11-00-00-cx-blog-1.jsonl");
    cpSync("fixtures/codex/rollout-completed.jsonl", filePath);
    // Pin mtime to ensure deterministic behavior
    const d = new Date("2026-07-07T12:00:00.000Z");
    utimesSync(filePath, d, d);
    cpSync("fixtures/codex/session_index.jsonl", join(root, "session_index.jsonl"));
    const now = new Date("2026-07-08T09:00:00.000Z");
    const sessions = await scanCodex({ since: new Date(now.getTime() - 86_400_000), now, rootDir: root });
    expect(sessions.length).toBe(1);
    expect(sessions[0]!.title).toBe("Write launch blog post");
  });

  test("missing rootDir returns empty", async () => {
    expect(await scanCodex({ since: new Date(), now: new Date(), rootDir: "/nope" })).toEqual([]);
  });
});
