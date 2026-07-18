import { describe, expect, spyOn, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCodexSession, scanCodex, stripAmbientBlocks } from "../src/connectors/codex";
import { makeClip } from "../src/connectors/jsonl";

const completed = readFileSync("fixtures/codex/rollout-completed.jsonl", "utf8");
const approval = readFileSync("fixtures/codex/rollout-approval.jsonl", "utf8");
const modern = readFileSync("fixtures/codex/rollout-modern.jsonl", "utf8");
const guardian = readFileSync("fixtures/codex/rollout-guardian.jsonl", "utf8");
const titles = new Map([
  ["cx-blog-1", "Write launch blog post"],
  ["cx-deploy-1", "Terraform deploy"],
]);

describe("parseCodexSession", () => {
  const line = (o: unknown) => JSON.stringify(o);
  const meta = line({ type: "session_meta", timestamp: "2026-07-07T10:00:00Z", payload: { id: "c1", cwd: "/w" } });
  const parse = (rest: string[]) => parseCodexSession([meta, ...rest].join("\n"), new Map())!;

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
    const s = parse([
      line({ type: "event_msg", timestamp: "2026-07-07T10:01:00Z", payload: { type: "exec_command_begin", command: ["npm", "run", "build"] } }),
      line({ type: "event_msg", timestamp: "2026-07-07T10:02:00Z", payload: { type: "error", message: "build failed" } }),
    ]);
    expect(s.errors[0]).toBe("build failed — while exec: npm run build");
  });

  test("error before any exec command yields the bare message with no exec context", () => {
    const s = parse([
      line({ type: "event_msg", timestamp: "2026-07-07T10:01:00Z", payload: { type: "error", message: "auth token expired" } }),
    ]);
    expect(s.errors[0]).toBe("auth token expired");
  });

  describe("error and stream_error events", () => {
    test("error records a failed event and clears awaitingUser", () => {
      const s = parse([
        line({ type: "event_msg", timestamp: "2026-07-07T10:01:00Z", payload: { type: "agent_message" } }),
        line({ type: "event_msg", timestamp: "2026-07-07T10:02:00Z", payload: { type: "error", message: "boom" } }),
      ]);
      expect(s.events.at(-1)!.type).toBe("failed");
      expect(s.events.at(-1)!.summary).toBe("boom");
      expect(s.awaitingUser).toBe(false);
    });

    test("stream_error records a failed event and clears midWork", () => {
      const s = parse([
        line({ type: "event_msg", timestamp: "2026-07-07T10:01:00Z", payload: { type: "task_started" } }),
        line({ type: "event_msg", timestamp: "2026-07-07T10:02:00Z", payload: { type: "stream_error", message: "connection reset" } }),
      ]);
      expect(s.events.at(-1)!.type).toBe("failed");
      expect(s.events.at(-1)!.summary).toBe("connection reset");
      expect(s.errors).toEqual(["connection reset"]);
      expect(s.midWork).toBe(false);
      expect(s.awaitingUser).toBe(false);
    });

    test("error with no message falls back to the literal 'error'", () => {
      const s = parse([
        line({ type: "event_msg", timestamp: "2026-07-07T10:01:00Z", payload: { type: "error" } }),
      ]);
      expect(s.errors).toEqual(["error"]);
    });
  });

  describe("user redactPatterns run before truncation (asl-f4k)", () => {
    const clip = makeClip(["CORPSECRET_[A-Z_]+"]);
    const secret = "CORPSECRET_" + "Z".repeat(60);

    test("error message: pattern secret straddling the 200-char first-line slice never leaks a prefix", () => {
      const text = [
        meta,
        line({ type: "event_msg", timestamp: "2026-07-07T10:02:00Z", payload: { type: "error", message: `${"m".repeat(150)} ${secret} trailing` } }),
      ].join("\n");
      const s = parseCodexSession(text, new Map(), undefined, clip)!;
      expect(s.errors[0]).toContain("[REDACTED]");
      expect(s.errors[0]).not.toContain("CORPSECRET");
    });

    test("in-flight exec command: pattern secret is redacted before the context slice", () => {
      const text = [
        meta,
        line({ type: "event_msg", timestamp: "2026-07-07T10:01:00Z", payload: { type: "exec_command_begin", command: `${"x".repeat(60)} ${secret}` } }),
        line({ type: "event_msg", timestamp: "2026-07-07T10:02:00Z", payload: { type: "error", message: "build failed" } }),
      ].join("\n");
      const s = parseCodexSession(text, new Map(), undefined, clip)!;
      expect(s.errors[0]).toContain("[REDACTED]");
      expect(s.errors[0]).not.toContain("CORPSECRET");
    });
  });

  test("a finished exec command is not blamed for a later error", () => {
    const s = parse([
      line({ type: "event_msg", timestamp: "2026-07-07T10:01:00Z", payload: { type: "exec_command_begin", command: "ls" } }),
      line({ type: "event_msg", timestamp: "2026-07-07T10:01:05Z", payload: { type: "exec_command_end" } }),
      line({ type: "event_msg", timestamp: "2026-07-07T10:02:00Z", payload: { type: "stream_error", message: "connection reset" } }),
    ]);
    expect(s.errors[0]).toBe("connection reset");
  });

  describe("awaitingUser", () => {
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

    test("false when last event is exec_approval_request (agent waits on approval, not chat)", () => {
      expect(parse([
        line({ type: "event_msg", timestamp: "2026-07-07T10:01:00Z", payload: { type: "agent_message" } }),
        line({ type: "event_msg", timestamp: "2026-07-07T10:02:00Z", payload: { type: "exec_approval_request", command: "terraform apply" } }),
      ]).awaitingUser).toBe(false);
    });

    test("false when last event is apply_patch_approval_request", () => {
      expect(parse([
        line({ type: "event_msg", timestamp: "2026-07-07T10:01:00Z", payload: { type: "agent_message" } }),
        line({ type: "event_msg", timestamp: "2026-07-07T10:02:00Z", payload: { type: "apply_patch_approval_request" } }),
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

describe("modern rollout schema (codex-cli 0.144+)", () => {
  const line = (o: unknown) => JSON.stringify(o);
  const meta = line({ type: "session_meta", timestamp: "2026-07-16T09:00:00Z", payload: { id: "cm1", cwd: "/w", originator: "codex_cli_rs", source: "cli" } });
  const parse = (rest: string[], titles = new Map<string, string>()) => parseCodexSession([meta, ...rest].join("\n"), titles)!;
  const s = parseCodexSession(modern, new Map())!;

  test("title derives from the first task-bearing user_message, ambient block stripped", () => {
    expect(s.title).toBe("Review the connector branch for redaction gaps");
  });

  test("derived title wins over a stale session_index title", () => {
    const withIndex = parseCodexSession(modern, new Map([["cx-modern-1", "stale index name"]]))!;
    expect(withIndex.title).toBe("Review the connector branch for redaction gaps");
  });

  test("session_index title remains the fallback when no user_message bears a task", () => {
    const t = parse(
      [line({ type: "event_msg", timestamp: "2026-07-16T09:00:03Z", payload: { type: "task_started" } })],
      new Map([["cm1", "from the index"]]),
    );
    expect(t.title).toBe("from the index");
  });

  test("user_message emits a task event with ambient UI blocks stripped", () => {
    const task = s.events.find((e) => e.summary.startsWith("task:"))!;
    expect(task.summary).toContain("Review the connector branch for redaction gaps");
    expect(task.summary).not.toContain("in-app-browser-context");
    expect(task.summary).not.toContain("ambient");
  });

  test("ambient-only user_message is not task-bearing: no title, no task event", () => {
    const t = parse([
      line({ type: "event_msg", timestamp: "2026-07-16T09:00:02Z", payload: { type: "user_message", message: '<in-app-browser-context source="ambient-ui-state">\ntab state\n</in-app-browser-context>' } }),
    ]);
    expect(t.title).toBeUndefined();
    expect(t.events.some((e) => e.summary.startsWith("task:"))).toBe(false);
  });

  test("agent_message summary is the clipped message text, not the literal type", () => {
    const agent = s.events.filter((e) => e.type === "run_progressed" && e.summary.includes("diff looks clean"));
    expect(agent.length).toBe(1);
    expect(s.events.some((e) => e.summary === "agent_message")).toBe(false);
  });

  test("custom_tool_call exec extracts the cmd string as a command event", () => {
    expect(s.events.some((e) => e.summary === "exec: git diff --stat main...feature")).toBe(true);
    expect(s.events.some((e) => e.summary === "exec: bun test tests/missing.test.ts")).toBe(true);
  });

  test("function_call records a generic tool event", () => {
    expect(s.events.some((e) => e.summary === "tool: wait")).toBe(true);
  });

  test("Script failed output infers an error carrying the triggering command", () => {
    expect(s.errors.length).toBe(1);
    expect(s.errors[0]).toContain("ModuleNotFoundError");
    expect(s.errors[0]).toContain("— while exec: bun test tests/missing.test.ts");
    expect(s.events.some((e) => e.type === "failed")).toBe(true);
  });

  test("successful array-form output infers nothing", () => {
    // the first exec in the fixture succeeds; only the second contributes an error
    expect(s.errors.length).toBe(1);
  });

  test("task_complete captures last_agent_message and duration_ms", () => {
    const done = s.events.find((e) => e.type === "completed")!;
    expect(done.summary).toContain("Review finished: no redaction gaps found.");
    expect(done.summary).toContain("53s");
  });

  test("session ends awaiting the user, not mid-work", () => {
    expect(s.awaitingUser).toBe(true);
    expect(s.midWork).toBe(false);
  });

  test("read-only MCP session is tagged as a review", () => {
    expect(s.sessionKind).toBe("review");
  });

  test("workspace-write MCP session carries no review tag", () => {
    const t = parseCodexSession([
      line({ type: "session_meta", timestamp: "2026-07-16T09:00:00Z", payload: { id: "cm2", cwd: "/w", source: "mcp" } }),
      line({ type: "turn_context", timestamp: "2026-07-16T09:00:01Z", payload: { model: "gpt-5.6-sol", sandbox_policy: { type: "workspace-write", network_access: false } } }),
      line({ type: "event_msg", timestamp: "2026-07-16T09:00:03Z", payload: { type: "task_started" } }),
    ].join("\n"), new Map())!;
    expect(t.sessionKind).toBeUndefined();
  });

  test("nonzero-exit first line infers an error; buried error text does not", () => {
    const t = parse([
      line({ type: "response_item", timestamp: "2026-07-16T09:01:00Z", payload: { type: "custom_tool_call", call_id: "c1", name: "exec", input: 'tools.exec_command({cmd:"make build"})' } }),
      line({ type: "response_item", timestamp: "2026-07-16T09:01:05Z", payload: { type: "custom_tool_call_output", call_id: "c1", output: "Command exited with code 127\nmake: not found" } }),
      line({ type: "response_item", timestamp: "2026-07-16T09:01:10Z", payload: { type: "custom_tool_call", call_id: "c2", name: "exec", input: 'tools.exec_command({cmd:"ls dirs"})' } }),
      line({ type: "response_item", timestamp: "2026-07-16T09:01:15Z", payload: { type: "custom_tool_call_output", call_id: "c2", output: "Script completed\nWall time 0.1 seconds\nOutput:\nls: /nope: No such file or directory\nok" } }),
    ]);
    expect(t.errors.length).toBe(1);
    expect(t.errors[0]).toContain("exited with code 127");
    expect(t.errors[0]).toContain("— while exec: make build");
  });

  test("a finished exec output is not blamed for a later legacy error", () => {
    const t = parse([
      line({ type: "response_item", timestamp: "2026-07-16T09:01:00Z", payload: { type: "custom_tool_call", call_id: "c1", name: "exec", input: 'tools.exec_command({cmd:"ls"})' } }),
      line({ type: "response_item", timestamp: "2026-07-16T09:01:05Z", payload: { type: "custom_tool_call_output", call_id: "c1", output: "Script completed\nfine" } }),
      line({ type: "event_msg", timestamp: "2026-07-16T09:02:00Z", payload: { type: "stream_error", message: "connection reset" } }),
    ]);
    expect(t.errors).toEqual(["connection reset"]);
  });

  test("trailing custom_tool_call leaves the session mid-work", () => {
    const t = parse([
      line({ type: "event_msg", timestamp: "2026-07-16T09:00:50Z", payload: { type: "agent_message", message: "checking" } }),
      line({ type: "response_item", timestamp: "2026-07-16T09:01:00Z", payload: { type: "custom_tool_call", call_id: "c1", name: "exec", input: 'tools.exec_command({cmd:"sleep 5"})' } }),
    ]);
    expect(t.midWork).toBe(true);
    expect(t.awaitingUser).toBe(false);
  });

  test("trailing tool output still owes agent processing: mid-work, not awaiting", () => {
    const t = parse([
      line({ type: "response_item", timestamp: "2026-07-16T09:01:00Z", payload: { type: "custom_tool_call", call_id: "c1", name: "exec", input: 'tools.exec_command({cmd:"ls"})' } }),
      line({ type: "response_item", timestamp: "2026-07-16T09:01:05Z", payload: { type: "custom_tool_call_output", call_id: "c1", output: "Script completed\nok" } }),
    ]);
    expect(t.midWork).toBe(true);
    expect(t.awaitingUser).toBe(false);
  });

  test("patch_apply_end changes keys populate filesTouched", () => {
    const t = parse([
      line({ type: "event_msg", timestamp: "2026-07-16T09:01:00Z", payload: { type: "patch_apply_end", success: true, changes: { "/w/src/b.ts": { type: "update" }, "/w/src/a.ts": { type: "add" } } } }),
    ]);
    expect(t.filesTouched).toEqual(["/w/src/a.ts", "/w/src/b.ts"]);
  });

  test("guardian session (subagent source + codex-auto-review) is tagged guardian and its dump never becomes a title", () => {
    const g = parseCodexSession(guardian, new Map())!;
    expect(g.sessionKind).toBe("guardian");
    expect(g.title).toBeUndefined();
  });

  test("codex-auto-review model alone marks a session guardian", () => {
    const t = parse([
      line({ type: "turn_context", timestamp: "2026-07-16T09:00:01Z", payload: { model: "codex-auto-review", sandbox_policy: { type: "read-only" } } }),
      line({ type: "event_msg", timestamp: "2026-07-16T09:00:03Z", payload: { type: "task_started" } }),
    ]);
    expect(t.sessionKind).toBe("guardian");
  });

  test("interleaved tool outputs attribute failures by call_id, not adjacency", () => {
    const t = parse([
      line({ type: "response_item", timestamp: "2026-07-16T09:01:00Z", payload: { type: "custom_tool_call", call_id: "cA", name: "exec", input: 'tools.exec_command({cmd:"make build"})' } }),
      line({ type: "response_item", timestamp: "2026-07-16T09:01:01Z", payload: { type: "custom_tool_call", call_id: "cB", name: "exec", input: 'tools.exec_command({cmd:"bun test"})' } }),
      line({ type: "response_item", timestamp: "2026-07-16T09:01:05Z", payload: { type: "custom_tool_call_output", call_id: "cB", output: "Script failed: exit 1\ntests failed" } }),
      line({ type: "response_item", timestamp: "2026-07-16T09:01:06Z", payload: { type: "custom_tool_call_output", call_id: "cA", output: "Command exited with code 2" } }),
    ]);
    expect(t.errors.length).toBe(2);
    expect(t.errors[0]).toContain("— while exec: bun test");
    expect(t.errors[1]).toContain("— while exec: make build");
  });

  test("a non-exec call's failing output is never blamed on a prior exec", () => {
    const t = parse([
      line({ type: "response_item", timestamp: "2026-07-16T09:01:00Z", payload: { type: "custom_tool_call", call_id: "cA", name: "exec", input: 'tools.exec_command({cmd:"ls"})' } }),
      line({ type: "response_item", timestamp: "2026-07-16T09:01:01Z", payload: { type: "custom_tool_call_output", call_id: "cA", output: "Script completed\nok" } }),
      line({ type: "response_item", timestamp: "2026-07-16T09:01:02Z", payload: { type: "function_call", call_id: "cB", name: "web_search" } }),
      line({ type: "response_item", timestamp: "2026-07-16T09:01:05Z", payload: { type: "function_call_output", call_id: "cB", output: "Script failed: exit 1\nsearch backend down" } }),
    ]);
    expect(t.errors.length).toBe(1);
    expect(t.errors[0]).not.toContain("— while exec");
  });

  test("a null jsonl line mid-file does not discard the session", () => {
    const t = parseCodexSession([
      meta,
      "null",
      line({ type: "event_msg", timestamp: "2026-07-16T09:00:03Z", payload: { type: "task_complete", last_agent_message: "done" } }),
      "42",
    ].join("\n"), new Map());
    expect(t).not.toBeNull();
    expect(t!.events.some((e) => e.type === "completed")).toBe(true);
  });

  test("read-only then workspace-write turn contexts do NOT tag the session review", () => {
    const t = parseCodexSession([
      line({ type: "session_meta", timestamp: "2026-07-16T09:00:00Z", payload: { id: "cm3", cwd: "/w", source: "mcp" } }),
      line({ type: "turn_context", timestamp: "2026-07-16T09:00:01Z", payload: { model: "gpt-5.6-sol", sandbox_policy: { type: "read-only" } } }),
      line({ type: "turn_context", timestamp: "2026-07-16T09:05:00Z", payload: { model: "gpt-5.6-sol", sandbox_policy: { type: "workspace-write" } } }),
      line({ type: "event_msg", timestamp: "2026-07-16T09:05:03Z", payload: { type: "task_started" } }),
    ].join("\n"), new Map())!;
    expect(t.sessionKind).toBeUndefined();
  });

  test("extractExecCmd tolerates a JSON-quoted cmd key", () => {
    const t = parse([
      line({ type: "response_item", timestamp: "2026-07-16T09:01:00Z", payload: { type: "custom_tool_call", call_id: "c1", name: "exec", input: '{"cmd":"git status","workdir":"/w"}' } }),
    ]);
    expect(t.events.some((e) => e.summary === "exec: git status")).toBe(true);
  });

  describe("stripAmbientBlocks robustness", () => {
    test("case-variant tags are stripped", () => {
      expect(stripAmbientBlocks('do it <IN-APP-BROWSER-CONTEXT>tabs</IN-APP-BROWSER-CONTEXT> now')).toBe("do it  now".trim());
      expect(stripAmbientBlocks('go <Div Source="Ambient-ui">x</Div>')).toBe("go");
    });

    test("an unclosed ambient block strips from the opening tag to end of message", () => {
      expect(stripAmbientBlocks('fix the bug <in-app-browser-context source="ambient-ui-state">\ntab dump that never closes')).toBe("fix the bug");
      expect(stripAmbientBlocks('<other source="ambient-tabs">dangling forever')).toBe("");
    });
  });

  test("user redactPatterns still run before truncation on task and exec text", () => {
    const clip = makeClip(["CORPSECRET_[A-Z_]+"]);
    const secret = "CORPSECRET_" + "Z".repeat(60);
    const text = [
      meta,
      line({ type: "event_msg", timestamp: "2026-07-16T09:00:02Z", payload: { type: "user_message", message: `fix ${secret} now` } }),
      line({ type: "response_item", timestamp: "2026-07-16T09:00:12Z", payload: { type: "custom_tool_call", call_id: "c1", name: "exec", input: `tools.exec_command({cmd:"echo ${secret}"})` } }),
    ].join("\n");
    const t = parseCodexSession(text, new Map(), undefined, clip)!;
    const all = [t.title, ...t.events.map((e) => e.summary)].join("\n");
    expect(all).toContain("[REDACTED]");
    expect(all).not.toContain("CORPSECRET");
  });
});

describe("scanCodex", () => {
  test("guardian sessions are excluded from scan output", async () => {
    const root = mkdtempSync(join(tmpdir(), "asl-cx-guard-"));
    const day = join(root, "sessions", "2026", "07", "16");
    mkdirSync(day, { recursive: true });
    for (const [src, name] of [["rollout-modern.jsonl", "rollout-2026-07-16T09-00-00-cx-modern-1.jsonl"], ["rollout-guardian.jsonl", "rollout-2026-07-16T10-00-00-cx-guardian-1.jsonl"]] as const) {
      const p = join(day, name);
      cpSync(join("fixtures/codex", src), p);
      const d = new Date("2026-07-16T12:00:00.000Z");
      utimesSync(p, d, d);
    }
    const now = new Date("2026-07-17T09:00:00.000Z");
    const sessions = await scanCodex({ since: new Date(now.getTime() - 86_400_000 * 2), now, rootDir: root, redactPatterns: [] });
    expect(sessions.map((x) => x.sessionId)).toEqual(["cx-modern-1"]);
  });

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
    const sessions = await scanCodex({ since: new Date(now.getTime() - 86_400_000), now, rootDir: root , redactPatterns: [] });
    expect(sessions.length).toBe(1);
    expect(sessions[0]!.title).toBe("Write launch blog post");
  });

  describe("scan window vs session start date (asl-axa)", () => {
    const plant = (root: string, day: string, name: string, fixture: string, mtime: Date) => {
      const dir = join(root, "sessions", ...day.split("/"));
      mkdirSync(dir, { recursive: true });
      const p = join(dir, name);
      cpSync(join("fixtures/codex", fixture), p);
      utimesSync(p, mtime, mtime);
      return p;
    };
    const now = new Date("2026-07-17T09:00:00.000Z");
    const since = new Date(now.getTime() - 86_400_000); // 24h window

    test("a session started before the window but active inside it is ingested", async () => {
      const root = mkdtempSync(join(tmpdir(), "asl-cx-long-"));
      // Binned under its START date (2026/07/01) — far outside the 24h window —
      // but the file was appended to inside the window (mtime).
      plant(root, "2026/07/01", "rollout-2026-07-01T09-00-00-cx-modern-1.jsonl", "rollout-modern.jsonl", new Date("2026-07-17T08:30:00.000Z"));
      const sessions = await scanCodex({ since, now, rootDir: root, redactPatterns: [] });
      expect(sessions.map((s) => s.sessionId)).toEqual(["cx-modern-1"]);
    });

    test("a file untouched since the window start is skipped without being read", async () => {
      const root = mkdtempSync(join(tmpdir(), "asl-cx-stale-"));
      // Unreadable file: if the scan ever tried to READ it, scanSessionFile
      // would catch EACCES and log a "skipping" warning. The mtime gate must
      // reject it on stat alone — no read, no warning, no session.
      const p = plant(root, "2026/07/01", "rollout-2026-07-01T09-00-00-cx-stale-1.jsonl", "rollout-modern.jsonl", new Date("2026-07-10T08:00:00.000Z"));
      chmodSync(p, 0o000);
      const warn = spyOn(console, "error");
      try {
        const sessions = await scanCodex({ since, now, rootDir: root, redactPatterns: [] });
        expect(sessions).toEqual([]);
        expect(warn.mock.calls.filter((c) => String(c[0]).includes(p)).length).toBe(0);
      } finally {
        warn.mockRestore();
        chmodSync(p, 0o644);
      }
    });

    test("a fresh-mtime file whose events all predate the window is rejected post-parse", async () => {
      const root = mkdtempSync(join(tmpdir(), "asl-cx-touch-"));
      // A backup/copy tool touched an old rollout (mtime inside the window)
      // but its newest event is 2026-07-16T09:00:53Z — outside since. The
      // post-parse lastEventAt check must exclude it.
      plant(root, "2026/07/16", "rollout-2026-07-16T09-00-00-cx-modern-1.jsonl", "rollout-modern.jsonl", new Date("2026-07-17T08:30:00.000Z"));
      const staleSince = new Date("2026-07-16T12:00:00.000Z");
      expect(await scanCodex({ since: staleSince, now, rootDir: root, redactPatterns: [] })).toEqual([]);
      // Sanity: with a window covering the events, the same file IS ingested.
      const wide = await scanCodex({ since: new Date("2026-07-16T00:00:00.000Z"), now, rootDir: root, redactPatterns: [] });
      expect(wide.map((s) => s.sessionId)).toEqual(["cx-modern-1"]);
    });

    test("an unreadable date dir does not prevent other dirs' sessions from loading", async () => {
      const root = mkdtempSync(join(tmpdir(), "asl-cx-eacces-"));
      plant(root, "2026/07/16", "rollout-2026-07-16T09-00-00-cx-modern-1.jsonl", "rollout-modern.jsonl", new Date("2026-07-17T08:30:00.000Z"));
      const badDay = join(root, "sessions", "2026", "07", "15");
      mkdirSync(badDay, { recursive: true });
      chmodSync(badDay, 0o000);
      const warn = spyOn(console, "error");
      try {
        const sessions = await scanCodex({ since: new Date("2026-07-16T00:00:00.000Z"), now, rootDir: root, redactPatterns: [] });
        expect(sessions.map((s) => s.sessionId)).toEqual(["cx-modern-1"]);
        expect(warn.mock.calls.some((c) => String(c[0]).includes(badDay))).toBe(true);
      } finally {
        warn.mockRestore();
        chmodSync(badDay, 0o755);
      }
    });

    test("guardian exclusion holds for out-of-window-started guardian files", async () => {
      const root = mkdtempSync(join(tmpdir(), "asl-cx-oldguard-"));
      plant(root, "2026/07/01", "rollout-2026-07-01T10-00-00-cx-guardian-1.jsonl", "rollout-guardian.jsonl", new Date("2026-07-17T08:30:00.000Z"));
      expect(await scanCodex({ since, now, rootDir: root, redactPatterns: [] })).toEqual([]);
    });
  });

  test("missing rootDir returns empty", async () => {
    expect(await scanCodex({ since: new Date(), now: new Date(), rootDir: "/nope" , redactPatterns: [] })).toEqual([]);
  });
});
