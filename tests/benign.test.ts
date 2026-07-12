import { describe, expect, test } from "bun:test";
import { isBenignToolError } from "../src/connectors/benign";
import { parseClaudeSession } from "../src/connectors/claude-code";

// Cases drawn from a 5-day sample of real is_error tool_results (116 results,
// 87 distinct) — see asl-4h6 design notes. The classifier fails toward
// alerting: anything compound or ambiguous stays an error.
describe("isBenignToolError", () => {
  const bash = (command: string) => ({ name: "Bash", input: { command } });

  test("user rejection of a tool call is benign steering, not a blocker", () => {
    expect(isBenignToolError(bash("rm -rf build"), "The user doesn't want to proceed with this tool use. The tool use was rejected")).toBe(true);
  });

  test("harness protocol nudges (<tool_use_error>) are benign", () => {
    expect(isBenignToolError({ name: "Edit", input: undefined }, "<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>")).toBe(true);
    expect(isBenignToolError(bash("sleep 60"), "<tool_use_error>Blocked: standalone sleep 60. To wait for a condition, use Monitor</tool_use_error>")).toBe(true);
    expect(isBenignToolError({ name: "Monitor", input: undefined }, "<tool_use_error>InputValidationError: the required parameter `description` is missing</tool_use_error>")).toBe(true);
  });

  test("Bash exit 1 from a simple search-y command is benign exploration", () => {
    expect(isBenignToolError(bash("grep -rn withContext src/"), "Exit code 1")).toBe(true);
    expect(isBenignToolError(bash("ls test/map/"), "Exit code 1 ls: test/map/: No such file or directory")).toBe(true);
    expect(isBenignToolError(bash("which ghostty"), "Exit code 1 /Applications/cmux.app")).toBe(true);
    expect(isBenignToolError(bash("cat missing.txt"), "Exit code 1 cat: missing.txt: No such file or directory")).toBe(true);
  });

  test("pipelines of search-y commands are benign (exit status is the last command's)", () => {
    expect(isBenignToolError(bash("grep -rn TODO src | head -5"), "Exit code 1")).toBe(true);
  });

  test("compound commands are never benign — the failing segment is ambiguous", () => {
    expect(isBenignToolError(bash("bun test && rg TODO src"), "Exit code 1 3 tests failed")).toBe(false);
    expect(isBenignToolError(bash("ls dist && bun run deploy"), "Exit code 1 deploy failed")).toBe(false);
    expect(isBenignToolError(bash("cd /x && cat /Users/gd/github/*gtm*"), "Exit code 1 (eval):1: no matches found")).toBe(false);
  });

  test("a not-found body does not excuse a non-search-y command", () => {
    expect(isBenignToolError(bash("bun run build"), "Exit code 1 Error: ENOENT: no such file or directory, open 'config.json'")).toBe(false);
  });

  test("Read of a missing file is benign exploration", () => {
    expect(isBenignToolError({ name: "Read", input: { file_path: "/nope" } }, "File does not exist. Note: your current working directory is /w")).toBe(true);
  });

  test("real failures stay errors", () => {
    expect(isBenignToolError(bash("bun test"), "Exit code 1 3 tests failed")).toBe(false);
    expect(isBenignToolError(bash("xcodebuild build"), "Exit code 143 Command timed out after 2m 0s")).toBe(false);
    expect(isBenignToolError(bash("git push"), "Exit code 128 fatal: not a git repository")).toBe(false);
    expect(isBenignToolError({ name: "WebFetch", input: undefined }, "ECONNREFUSED")).toBe(false);
    expect(isBenignToolError(bash("aws s3 ls"), "Error: missing AWS credentials")).toBe(false);
    expect(isBenignToolError(undefined, "Exit code 1")).toBe(false);
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
