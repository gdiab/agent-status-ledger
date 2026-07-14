import { describe, expect, test } from "bun:test";
import { checkEngramAvailable, upgradeEvidence, type Exec } from "../src/connectors/engram";

const execOk =
  (stdout: string): Exec =>
  () => ({ ok: true, stdout, stderr: "" });
const execFail: Exec = () => ({ ok: false, stdout: "", stderr: "not found" });

const FILE = "/Users/gd/github/agent-status-ledger/src/email.ts";

function explainStdout(json: unknown): string {
  // real CLI output shape: two prefix lines, then the JSON on its own line
  return `config: /Users/gd/.engram/config.yml\ndb: /Users/gd/.engram/index.sqlite\n${JSON.stringify(json)}\n`;
}

describe("checkEngramAvailable", () => {
  test("passes when the binary responds", () => {
    const r = checkEngramAvailable("/path/to/engram", execOk("engram help text"));
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("/path/to/engram");
    expect(r.fix).toBeUndefined();
  });

  test("fails with a build hint when the binary is missing or errors", () => {
    const r = checkEngramAvailable("/path/to/engram", execFail);
    expect(r.ok).toBe(false);
    expect(r.fix).toContain("cargo build");
  });
});

describe("upgradeEvidence", () => {
  test("does not match when the binary is missing (exec not ok)", async () => {
    const r = await upgradeEvidence(FILE, "/path/to/engram", execFail);
    expect(r.matched).toBe(false);
    expect(r.citation).toBeUndefined();
  });

  test("does not match on a non-zero exit / error response", async () => {
    const exec: Exec = () => ({
      ok: false,
      stdout: explainStdout({ error: "no_results", query: FILE }),
      stderr: "",
    });
    const r = await upgradeEvidence(FILE, "/path/to/engram", exec);
    expect(r.matched).toBe(false);
  });

  test("does not match on an explicit error key even if exec reports ok", async () => {
    const exec: Exec = () => ({
      ok: true,
      stdout: explainStdout({ error: "no_results", query: FILE }),
      stderr: "",
    });
    const r = await upgradeEvidence(FILE, "/path/to/engram", exec);
    expect(r.matched).toBe(false);
  });

  test("does not match on malformed JSON", async () => {
    const exec: Exec = () => ({
      ok: true,
      stdout: "config: /x\ndb: /y\nnot valid json{{{",
      stderr: "",
    });
    const r = await upgradeEvidence(FILE, "/path/to/engram", exec);
    expect(r.matched).toBe(false);
  });

  test("matches on a high-confidence session that touched the exact file", async () => {
    const exec: Exec = () => ({
      ok: true,
      stdout: explainStdout({
        total: 1,
        sessions: [
          {
            session_id: "abc123",
            confidence: 0.9375,
            timestamp: "2026-07-14T18:03:50.604Z",
            files_touched: [FILE, "/other/file.ts"],
          },
        ],
      }),
      stderr: "",
    });
    const r = await upgradeEvidence(FILE, "/path/to/engram", exec);
    expect(r.matched).toBe(true);
    expect(r.citation).toContain("abc123");
    expect(r.citation).toContain("2026-07-14T18:03:50.604Z");
  });

  test("does not match when every qualifying session is below the 0.5 confidence floor", async () => {
    const exec: Exec = () => ({
      ok: true,
      stdout: explainStdout({
        total: 1,
        sessions: [
          { session_id: "low1", confidence: 0.375, timestamp: "t", files_touched: [FILE] },
          { session_id: "low2", confidence: 0.0625, timestamp: "t", files_touched: [FILE] },
        ],
      }),
      stderr: "",
    });
    const r = await upgradeEvidence(FILE, "/path/to/engram", exec);
    expect(r.matched).toBe(false);
  });

  test("does not match when the high-confidence session's files_touched omits the queried file", async () => {
    const exec: Exec = () => ({
      ok: true,
      stdout: explainStdout({
        total: 1,
        sessions: [
          { session_id: "abc123", confidence: 0.9, timestamp: "t", files_touched: ["/some/other/file.ts"] },
        ],
      }),
      stderr: "",
    });
    const r = await upgradeEvidence(FILE, "/path/to/engram", exec);
    expect(r.matched).toBe(false);
  });

  test("picks the first qualifying session when multiple sessions are returned", async () => {
    const exec: Exec = () => ({
      ok: true,
      stdout: explainStdout({
        total: 2,
        sessions: [
          { session_id: "no-file", confidence: 0.99, timestamp: "t1", files_touched: ["/other.ts"] },
          { session_id: "qualifies", confidence: 0.6, timestamp: "t2", files_touched: [FILE] },
        ],
      }),
      stderr: "",
    });
    const r = await upgradeEvidence(FILE, "/path/to/engram", exec);
    expect(r.matched).toBe(true);
    expect(r.citation).toContain("qualifies");
  });

  test("passes the file path as a bare explain target (no synthetic line range)", async () => {
    let seenArgv: string[] = [];
    const exec: Exec = (argv) => {
      seenArgv = argv;
      return { ok: true, stdout: explainStdout({ error: "no_results" }), stderr: "" };
    };
    await upgradeEvidence(FILE, "/path/to/engram", exec);
    expect(seenArgv).toEqual(["/path/to/engram", "explain", FILE]);
  });

  test("never throws even if exec itself throws", async () => {
    const throwingExec: Exec = () => {
      throw new Error("boom");
    };
    const r = await upgradeEvidence(FILE, "/path/to/engram", throwingExec);
    expect(r.matched).toBe(false);
  });
});
