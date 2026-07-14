import { describe, expect, test } from "bun:test";
import { corroborateSessions, upgradeEvidence } from "../src/connectors/engram";
import type { Exec } from "../src/exec";
import type { RawSession } from "../src/types";

const execOk =
  (stdout: string): Exec =>
  () => ({ ok: true, stdout, stderr: "" });
const execFail: Exec = () => ({ ok: false, stdout: "", stderr: "not found" });

// A harness session UUID, as found in RawSession.sessionId.
const UUID = "989533ee-ec57-4ac9-b510-9d6cb8b1b969";
const ENGRAM_SID = "cbe8ebd49d60f46dac4ca64c3058ad0617d5c888811025b771d82e94e2faa455";
const BIN = "/path/to/engram";
const EDIT_FILTER = '"k":"code.edit"';

function cliStdout(json: unknown): string {
  // real CLI output shape: two prefix lines, then the JSON on its own line
  return `config: /Users/gd/.engram/config.yml\ndb: /Users/gd/.engram/index.sqlite\n${JSON.stringify(json)}\n`;
}

function grepResponse(sessionIds: string[]): string {
  return cliStdout({
    returned: sessionIds.length,
    sessions: sessionIds.map((session_id, i) => ({
      session_id,
      // grep's confidence is a raw touch count (e.g. 325.0), NOT a 0-1 score
      confidence: 325.0 - i,
      files_touched: ["/whatever/file.ts"],
      timestamp: "2026-07-14T13:39:18.481Z",
    })),
  });
}

// peek returns raw tape event JSON, one event per content line, in
// session.content[].text — and --grep-filter over-matches (context lines of
// other kinds come back too), so realistic fixtures mix event kinds.
function peekResponse(events: unknown[]): string {
  return cliStdout({
    session: { content: events.map((ev, i) => ({ line: i + 1, text: JSON.stringify(ev) })) },
  });
}

function editEvent(file: string, sourceSessionId: string): unknown {
  return {
    file,
    k: "code.edit",
    range: [1, 10],
    range_basis: "line",
    source: { harness: "claude-code", session_id: sourceSessionId },
    t: "2026-07-14T13:39:18.481Z",
  };
}

const readEvent = {
  file: "/repo/src/read-only.ts",
  k: "code.read",
  source: { harness: "claude-code", session_id: UUID },
  t: "2026-07-14T13:39:18.481Z",
};

// Routes by subcommand: argv[1] is "grep" or "peek".
function twoStepExec(grepStdout: string, peekStdoutBySid: Record<string, string>): Exec {
  return (argv) => {
    if (argv[1] === "grep") return { ok: true, stdout: grepStdout, stderr: "" };
    if (argv[1] === "peek") {
      const sid = argv[2]!;
      const stdout = peekStdoutBySid[sid] ?? cliStdout({ error: "session_not_found", session_id: sid });
      return { ok: true, stdout, stderr: "" };
    }
    return { ok: false, stdout: "", stderr: `unexpected subcommand ${argv[1]}` };
  };
}

describe("upgradeEvidence", () => {
  test("does not match when the binary is missing (exec not ok)", async () => {
    const r = await upgradeEvidence(UUID, BIN, execFail);
    expect(r.matched).toBe(false);
    expect(r.citation).toBeUndefined();
  });

  test("does not match when grep returns an error / no sessions", async () => {
    const noResults = execOk(cliStdout({ error: "no_results", query: UUID }));
    expect((await upgradeEvidence(UUID, BIN, noResults)).matched).toBe(false);

    const emptySessions = execOk(cliStdout({ returned: 0, sessions: [] }));
    expect((await upgradeEvidence(UUID, BIN, emptySessions)).matched).toBe(false);
  });

  test("does not match on malformed grep JSON", async () => {
    const exec = execOk("config: /x\ndb: /y\nnot valid json{{{");
    const r = await upgradeEvidence(UUID, BIN, exec);
    expect(r.matched).toBe(false);
  });

  test("does not match when peek errors for the grep hit", async () => {
    const exec = twoStepExec(grepResponse([ENGRAM_SID]), {
      [ENGRAM_SID]: cliStdout({ error: "session_not_found", session_id: ENGRAM_SID }),
    });
    const r = await upgradeEvidence(UUID, BIN, exec);
    expect(r.matched).toBe(false);
  });

  test("does not match when peek returns zero code.edit lines (context lines of other kinds only)", async () => {
    const exec = twoStepExec(grepResponse([ENGRAM_SID]), {
      [ENGRAM_SID]: peekResponse([readEvent, readEvent]),
    });
    const r = await upgradeEvidence(UUID, BIN, exec);
    expect(r.matched).toBe(false);
  });

  test("does not match when the code.edit events belong to a different harness session (mention-only guard)", async () => {
    // e.g. an orchestrator transcript that quoted the UUID in a dispatch
    // prompt: grep finds it, but its edits carry the orchestrator's own
    // source.session_id, not the queried UUID.
    const exec = twoStepExec(grepResponse([ENGRAM_SID]), {
      [ENGRAM_SID]: peekResponse([editEvent("/repo/src/a.ts", "some-other-uuid")]),
    });
    const r = await upgradeEvidence(UUID, BIN, exec);
    expect(r.matched).toBe(false);
  });

  test("matches when a code.edit event carries the queried source.session_id, citing the edited files", async () => {
    const exec = twoStepExec(grepResponse([ENGRAM_SID]), {
      [ENGRAM_SID]: peekResponse([
        readEvent,
        editEvent("/repo/src/config.ts", UUID),
        editEvent("/repo/src/email.ts", UUID),
        editEvent("/repo/src/config.ts", UUID), // duplicate file, cited once
      ]),
    });
    const r = await upgradeEvidence(UUID, BIN, exec);
    expect(r.matched).toBe(true);
    expect(r.citation).toContain(ENGRAM_SID);
    expect(r.citation).toContain("/repo/src/config.ts");
    expect(r.citation).toContain("/repo/src/email.ts");
    expect((r.citation!.match(/\/repo\/src\/config\.ts/g) ?? []).length).toBe(1);
  });

  test("skips a mention-only top hit and matches a later grep candidate that passes the guard", async () => {
    const other = "1111111111111111111111111111111111111111111111111111111111111111";
    const exec = twoStepExec(grepResponse([other, ENGRAM_SID]), {
      [other]: peekResponse([editEvent("/repo/src/a.ts", "some-other-uuid")]),
      [ENGRAM_SID]: peekResponse([editEvent("/repo/src/b.ts", UUID)]),
    });
    const r = await upgradeEvidence(UUID, BIN, exec);
    expect(r.matched).toBe(true);
    expect(r.citation).toContain(ENGRAM_SID);
    expect(r.citation).toContain("/repo/src/b.ts");
  });

  test("issues the exact grep and peek argv shapes", async () => {
    const calls: string[][] = [];
    const inner = twoStepExec(grepResponse([ENGRAM_SID]), {
      [ENGRAM_SID]: peekResponse([editEvent("/repo/src/a.ts", UUID)]),
    });
    const exec: Exec = (argv) => {
      calls.push(argv);
      return inner(argv);
    };
    await upgradeEvidence(UUID, BIN, exec);
    expect(calls[0]).toEqual([BIN, "grep", UUID]);
    expect(calls[1]).toEqual([BIN, "peek", ENGRAM_SID, "--grep-filter", EDIT_FILTER]);
  });

  test("skips unparseable content lines without throwing and still matches later events", async () => {
    const exec = twoStepExec(grepResponse([ENGRAM_SID]), {
      [ENGRAM_SID]: cliStdout({
        session: {
          content: [
            { line: 1, text: "not json at all {{" },
            { line: 2, text: JSON.stringify(editEvent("/repo/src/a.ts", UUID)) },
          ],
        },
      }),
    });
    const r = await upgradeEvidence(UUID, BIN, exec);
    expect(r.matched).toBe(true);
  });

  // Session ids come from transcripts (harness side) and engram output (grep
  // side) — both untrusted. Anything not matching the UUID/hex-hash
  // allowlist must be rejected before it can reach an argv.
  test("rejects hostile or malformed harness session ids without ever calling exec", () => {
    for (const hostile of ["--help", "-x", "$(rm -rf /)", "", "a".repeat(65), "cc-p0; rm"]) {
      let calls = 0;
      const spy: Exec = () => {
        calls++;
        return { ok: true, stdout: "", stderr: "" };
      };
      const r = upgradeEvidence(hostile, BIN, spy);
      expect(r.matched).toBe(false);
      expect(calls).toBe(0);
    }
  });

  test("rejects a hostile engram session id from grep output without calling peek", () => {
    const peeked: string[] = [];
    const inner = twoStepExec(grepResponse(["--evil-flag", "not hex!", ENGRAM_SID]), {
      [ENGRAM_SID]: peekResponse([editEvent("/repo/src/a.ts", UUID)]),
    });
    const exec: Exec = (argv) => {
      if (argv[1] === "peek") peeked.push(argv[2]!);
      return inner(argv);
    };
    const r = upgradeEvidence(UUID, BIN, exec);
    // the hostile candidates are skipped, the legitimate one still matches
    expect(r.matched).toBe(true);
    expect(peeked).toEqual([ENGRAM_SID]);
  });

  test("ignores grep sessions without a usable session_id instead of throwing", async () => {
    const exec = twoStepExec(
      cliStdout({ returned: 1, sessions: [{ confidence: 325.0 }] }), // no session_id key
      {},
    );
    const r = await upgradeEvidence(UUID, BIN, exec);
    expect(r.matched).toBe(false);
  });

  test("peeks at most 3 grep candidates per session, even when grep returns more", async () => {
    const sids = ["cafe0001", "cafe0002", "cafe0003", "cafe0004", "cafe0005", "cafe0006"];
    const peeked: string[] = [];
    const inner = twoStepExec(
      grepResponse(sids),
      // every candidate peeks fine but fails the source.session_id guard,
      // so the loop would visit all six without a budget
      Object.fromEntries(sids.map((s) => [s, peekResponse([editEvent("/repo/a.ts", "some-other-uuid")])])),
    );
    const exec: Exec = (argv) => {
      if (argv[1] === "peek") peeked.push(argv[2]!);
      return inner(argv);
    };
    const r = await upgradeEvidence(UUID, BIN, exec);
    expect(r.matched).toBe(false);
    expect(peeked).toEqual(["cafe0001", "cafe0002", "cafe0003"]);
  });

  test("a timed-out engram call (ok:false, empty stdout) degrades to no match", async () => {
    // The shape makeSpawnExec produces when the 5s per-call timeout kills a
    // hung binary (e.g. locked SQLite DB): non-zero/absent exit, nothing on
    // stdout. Evidence must stay untouched, never hang the report run.
    const timedOut: Exec = () => ({ ok: false, stdout: "", stderr: "" });
    const r = await upgradeEvidence(UUID, BIN, timedOut);
    expect(r.matched).toBe(false);
  });

  test("never throws even if exec itself throws", async () => {
    const throwingExec: Exec = () => {
      throw new Error("boom");
    };
    const r = await upgradeEvidence(UUID, BIN, throwingExec);
    expect(r.matched).toBe(false);
  });
});

// The connector's single entry point: owns the enabled switch, the
// newest-first sort, both query budgets, the default real exec, and the one
// fail-soft boundary. buildReport's per-profile loop calls only this.
describe("corroborateSessions", () => {
  const enabled = { enabled: true, binaryPath: BIN };
  const disabled = { enabled: false, binaryPath: BIN };

  function rawSession(sessionId: string, startedAt: string): RawSession {
    return {
      platform: "claude-code", sessionId, cwd: "/w",
      startedAt, lastEventAt: startedAt,
      events: [], filesTouched: [], errors: [],
    };
  }

  const matchingExec = (uuid: string): Exec =>
    twoStepExec(grepResponse([ENGRAM_SID]), {
      [ENGRAM_SID]: peekResponse([editEvent("/repo/src/thing.ts", uuid)]),
    });

  test("returns no match without calling exec when the connector is disabled", () => {
    let calls = 0;
    const spy: Exec = () => {
      calls++;
      return { ok: true, stdout: "", stderr: "" };
    };
    const r = corroborateSessions([rawSession(UUID, "2026-07-07T12:00:00.000Z")], disabled, spy);
    expect(r.matched).toBe(false);
    expect(calls).toBe(0);
  });

  test("matches via an injected exec, returning the citation", () => {
    const r = corroborateSessions([rawSession(UUID, "2026-07-07T12:00:00.000Z")], enabled, matchingExec(UUID));
    expect(r.matched).toBe(true);
    expect(r.citation).toContain(ENGRAM_SID);
    expect(r.citation).toContain("/repo/src/thing.ts");
  });

  test("returns no match for an empty session list", () => {
    const r = corroborateSessions([], enabled, matchingExec(UUID));
    expect(r.matched).toBe(false);
  });

  test("tries sessions newest-first regardless of input order", () => {
    const grepped: string[] = [];
    const spy: Exec = (argv) => {
      if (argv[1] === "grep") grepped.push(argv[2]!);
      return { ok: true, stdout: JSON.stringify({ error: "no_results" }), stderr: "" };
    };
    const sessions = [
      rawSession("aaaa1111", "2026-07-07T10:00:00.000Z"), // oldest
      rawSession("cccc3333", "2026-07-07T12:00:00.000Z"), // newest
      rawSession("bbbb2222", "2026-07-07T11:00:00.000Z"),
    ];
    corroborateSessions(sessions, enabled, spy);
    expect(grepped).toEqual(["cccc3333", "bbbb2222", "aaaa1111"]);
  });

  test("greps at most 5 sessions per profile, even when more are supplied", () => {
    const grepped: string[] = [];
    const spy: Exec = (argv) => {
      if (argv[1] === "grep") grepped.push(argv[2]!);
      return { ok: true, stdout: JSON.stringify({ error: "no_results" }), stderr: "" };
    };
    // ascending start times; ids hex-shaped, newest are 7..3
    const sessions = Array.from({ length: 8 }, (_, i) =>
      rawSession(`aaaa000${i}`, `2026-07-07T0${i}:00:00.000Z`));
    const r = corroborateSessions(sessions, enabled, spy);
    expect(r.matched).toBe(false);
    expect(grepped).toEqual(["aaaa0007", "aaaa0006", "aaaa0005", "aaaa0004", "aaaa0003"]);
  });

  test("stops at the first matching session and doesn't keep querying afterward", () => {
    const grepped: string[] = [];
    const exec: Exec = (argv) => {
      if (argv[1] === "grep") {
        grepped.push(argv[2]!);
        if (argv[2] !== UUID) return { ok: true, stdout: JSON.stringify({ error: "no_results" }), stderr: "" };
        return { ok: true, stdout: grepResponse([ENGRAM_SID]), stderr: "" };
      }
      return { ok: true, stdout: peekResponse([editEvent("/repo/src/x.ts", UUID)]), stderr: "" };
    };
    const sessions = [
      rawSession("aaaa1111", "2026-07-07T10:00:00.000Z"),
      rawSession(UUID, "2026-07-07T11:00:00.000Z"),
      rawSession("bbbb2222", "2026-07-07T12:00:00.000Z"),
    ];
    const r = corroborateSessions(sessions, enabled, exec);
    expect(r.matched).toBe(true);
    // newest-first: bbbb2222 misses, UUID matches, aaaa1111 never tried
    expect(grepped).toEqual(["bbbb2222", UUID]);
  });

  test("never throws even if exec throws (the single fail-soft boundary)", () => {
    const throwingExec: Exec = () => {
      throw new Error("boom");
    };
    const r = corroborateSessions([rawSession(UUID, "2026-07-07T12:00:00.000Z")], enabled, throwingExec);
    expect(r.matched).toBe(false);
  });

  test("with no injected exec and enabled=true, actually runs the binary (default real seam)", () => {
    // The one deliberate semantic change from the review: enabled=true with
    // no injected seam runs engram for real instead of silently no-oping.
    // A nonexistent binary path exercises the default makeSpawnExec path and
    // degrades to no match, quickly and without throwing.
    const r = corroborateSessions(
      [rawSession(UUID, "2026-07-07T12:00:00.000Z")],
      { enabled: true, binaryPath: "/no/such/binary-xyz" },
      undefined,
    );
    expect(r.matched).toBe(false);
  });
});
