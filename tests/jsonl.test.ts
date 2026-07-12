import { describe, expect, spyOn, test } from "bun:test";
import { jsonlEntries, withContext } from "../src/connectors/jsonl";
import { parseClaudeSession } from "../src/connectors/claude-code";

describe("jsonlEntries", () => {
  test("valid lines still parse when a non-blank line fails JSON.parse", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const text = '{"a":1}\n{"b":2}\nnot-json-and-not-blank\n{"c":3}\n';
      const entries = [...jsonlEntries(text, "some/path.jsonl")];
      expect(entries).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("some/path.jsonl"));
    } finally {
      spy.mockRestore();
    }
  });

  test("logs 'input' when no path is given", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      [...jsonlEntries("broken-line-no-path\n")];
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("input"));
    } finally {
      spy.mockRestore();
    }
  });

  test("blank lines are skipped silently, never logged", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const entries = [...jsonlEntries("\n   \n{\"a\":1}\n")];
      expect(entries).toEqual([{ a: 1 }]);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("withContext", () => {
  test("composes message, tool, and input", () => {
    expect(withContext("exit code 143", "Bash", { command: "xcrun simctl list" }))
      .toBe('exit code 143 — while Bash: {"command":"xcrun simctl list"}');
  });

  test("collapses whitespace and truncates input to 80 chars with ellipsis", () => {
    const long = "a".repeat(100) + "\n" + "b".repeat(50);
    const out = withContext("boom", "Bash", long);
    expect(out).toBe(`boom — while Bash: ${"a".repeat(80)}…`);
  });

  test("omits the colon segment when input is empty", () => {
    expect(withContext("boom", "Bash", "")).toBe("boom — while Bash");
    expect(withContext("boom", "Bash", undefined)).toBe("boom — while Bash");
  });

  test("redacts a secret before truncation even when it straddles the 80-char boundary", () => {
    const padding = "x".repeat(50);
    const token = "ghp_" + "A".repeat(36);
    const out = withContext("boom", "Bash", `${padding} ${token}`);
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("ghp_");
  });

  test("applies user redactPatterns before truncation when the secret straddles the 80-char boundary", () => {
    const padding = "x".repeat(50);
    const secret = "CORPSECRET_" + "Z".repeat(40);
    const out = withContext("boom", "Bash", `${padding} ${secret}`, ["CORPSECRET_[A-Z_]+"]);
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("CORPSECRET");
  });
});

describe("parseClaudeSession with a truncated trailing line", () => {
  test("still returns a valid session for the well-formed lines, and warns with the source path", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const truncated =
        '{"type":"user","timestamp":"2026-07-07T09:00:00.000Z","cwd":"/work/demo","sessionId":"cc-trunc-1","message":{"role":"user","content":"do the thing"}}\n' +
        '{"type":"assistant","timestamp":"2026-07-07T09:05:00.000Z","cwd":"/work/demo","sessionId":"cc-trunc-1","message":{"role":"assistant","content":[{"type":"text","text":"working on it"}]}}\n' +
        '{"type":"assistant","timestamp":"2026-07-07T09:10:00.000Z","cwd":"/work/demo","sessionId":"cc-trunc-1","message":{"role":"assistant","content":[{"type":"tex'; // cut off mid-line, e.g. truncated task_complete
      const session = parseClaudeSession(truncated, "/fallback", "fixtures/claude-code/session-truncated.jsonl")!;
      expect(session).not.toBeNull();
      expect(session.sessionId).toBe("cc-trunc-1");
      expect(session.events.filter((e) => e.type === "run_progressed").length).toBe(2);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("fixtures/claude-code/session-truncated.jsonl"));
    } finally {
      spy.mockRestore();
    }
  });
});
