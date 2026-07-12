import { describe, expect, test } from "bun:test";
import { isBenignToolError } from "../src/connectors/benign";
import { parseClaudeSession } from "../src/connectors/claude-code";

// Cases drawn from a 5-day sample of real is_error tool_results (116 results,
// 87 distinct) — see asl-4h6 design notes.
describe("isBenignToolError", () => {
  test("user rejection of a tool call is benign steering, not a blocker", () => {
    expect(isBenignToolError("Bash", undefined, "The user doesn't want to proceed with this tool use. The tool use was rejected")).toBe(true);
  });

  test("harness protocol nudges (<tool_use_error>) are benign", () => {
    expect(isBenignToolError("Edit", undefined, "<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>")).toBe(true);
    expect(isBenignToolError("Bash", undefined, "<tool_use_error>Blocked: standalone sleep 60. To wait for a condition, use Monitor</tool_use_error>")).toBe(true);
    expect(isBenignToolError("Monitor", undefined, "<tool_use_error>InputValidationError: the required parameter `description` is missing</tool_use_error>")).toBe(true);
  });

  test("Bash exit 1 from a search-y command is benign exploration", () => {
    expect(isBenignToolError("Bash", { command: "grep -rn withContext src/" }, "Exit code 1")).toBe(true);
    expect(isBenignToolError("Bash", { command: "ls test/map/" }, "Exit code 1 ls: test/map/: No such file or directory")).toBe(true);
    expect(isBenignToolError("Bash", { command: "which ghostty" }, "Exit code 1 /Applications/cmux.app")).toBe(true);
  });

  test("Bash exit 1 with a not-found body is benign even when the command is compound", () => {
    expect(isBenignToolError("Bash", { command: "cd /x && cat /Users/gd/github/*gtm*" }, "Exit code 1 --- (eval):1: no matches found: /Users/gd/github/*gtm*")).toBe(true);
  });

  test("Read of a missing file is benign exploration", () => {
    expect(isBenignToolError("Read", { file_path: "/nope" }, "File does not exist. Note: your current working directory is /w")).toBe(true);
  });

  test("real failures stay errors", () => {
    expect(isBenignToolError("Bash", { command: "bun test" }, "Exit code 1 3 tests failed")).toBe(false);
    expect(isBenignToolError("Bash", { command: "xcodebuild build" }, "Exit code 143 Command timed out after 2m 0s")).toBe(false);
    expect(isBenignToolError("Bash", { command: "git push" }, "Exit code 128 fatal: not a git repository")).toBe(false);
    expect(isBenignToolError("WebFetch", undefined, "ECONNREFUSED")).toBe(false);
    expect(isBenignToolError("Bash", { command: "aws s3 ls" }, "Error: missing AWS credentials")).toBe(false);
  });
});

describe("parseClaudeSession ignores benign tool errors (asl-4h6)", () => {
  const line = (o: unknown) => JSON.stringify(o);
  const use = (id: string, name: string, input: unknown) =>
    line({ sessionId: "s", type: "assistant", timestamp: "2026-07-07T10:00:00Z", message: { content: [{ type: "tool_use", id, name, input }] } });
  const result = (id: string, content: string) =>
    line({ sessionId: "s", type: "user", timestamp: "2026-07-07T10:00:30Z", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: true, content }] } });

  test("a session ending on a no-match grep is not failed and reports no errors", () => {
    const text = [use("t1", "Bash", { command: "grep -rn missing src/" }), result("t1", "Exit code 1")].join("\n");
    const s = parseClaudeSession(text, "/w")!;
    expect(s.errors).toEqual([]);
    expect(s.events.at(-1)!.type).not.toBe("failed");
  });

  test("a user-rejected tool call reports no errors", () => {
    const text = [use("t1", "Bash", { command: "rm -rf build" }), result("t1", "The user doesn't want to proceed with this tool use. The tool use was rejected")].join("\n");
    const s = parseClaudeSession(text, "/w")!;
    expect(s.errors).toEqual([]);
    expect(s.events.at(-1)!.type).not.toBe("failed");
  });

  test("a real terminal failure still fails the session", () => {
    const text = [use("t1", "Bash", { command: "bun run build" }), result("t1", "Exit code 1 error: bundling failed")].join("\n");
    const s = parseClaudeSession(text, "/w")!;
    expect(s.errors.length).toBe(1);
    expect(s.events.at(-1)!.type).toBe("failed");
  });
});
