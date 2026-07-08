import { describe, expect, spyOn, test } from "bun:test";
import { jsonlEntries } from "../src/connectors/jsonl";
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
