import { describe, expect, test } from "bun:test";
import { corroborateSessions, discoverDispatchLinks, discoverTaskKeys, findTaskKeys, upgradeEvidence } from "../src/connectors/engram";
import type { Exec } from "../src/exec";
import {
  BIN, ENGRAM_SID, UUID,
  cliStdout, editEvent, grepResponse, markerQuery, peekResponse, rawSession, twoStepExec,
} from "./helpers/engram-fixtures";

const execOk =
  (stdout: string): Exec =>
  async () => ({ ok: true, stdout, stderr: "" });
const execFail: Exec = async () => ({ ok: false, stdout: "", stderr: "not found" });

const EDIT_FILTER = '"k":"code.edit"';

const readEvent = {
  file: "/repo/src/read-only.ts",
  k: "code.read",
  source: { harness: "claude-code", session_id: UUID },
  t: "2026-07-14T13:39:18.481Z",
};

describe("upgradeEvidence", () => {
  test("does not match when the binary is missing (exec not ok)", async () => {
    const r = await upgradeEvidence(UUID, BIN, execFail, []);
    expect(r.matched).toBe(false);
    expect(r.citation).toBeUndefined();
  });

  test("does not match when grep returns an error / no sessions", async () => {
    const noResults = execOk(cliStdout({ error: "no_results", query: UUID }));
    expect((await upgradeEvidence(UUID, BIN, noResults, [])).matched).toBe(false);

    const emptySessions = execOk(cliStdout({ returned: 0, sessions: [] }));
    expect((await upgradeEvidence(UUID, BIN, emptySessions, [])).matched).toBe(false);
  });

  test("does not match on malformed grep JSON", async () => {
    const exec = execOk("config: /x\ndb: /y\nnot valid json{{{");
    const r = await upgradeEvidence(UUID, BIN, exec, []);
    expect(r.matched).toBe(false);
  });

  test("does not match when peek errors for the grep hit", async () => {
    const exec = twoStepExec(grepResponse([ENGRAM_SID]), {
      [ENGRAM_SID]: cliStdout({ error: "session_not_found", session_id: ENGRAM_SID }),
    });
    const r = await upgradeEvidence(UUID, BIN, exec, []);
    expect(r.matched).toBe(false);
  });

  test("does not match when peek returns zero code.edit lines (context lines of other kinds only)", async () => {
    const exec = twoStepExec(grepResponse([ENGRAM_SID]), {
      [ENGRAM_SID]: peekResponse([readEvent, readEvent]),
    });
    const r = await upgradeEvidence(UUID, BIN, exec, []);
    expect(r.matched).toBe(false);
  });

  test("does not match when the code.edit events belong to a different harness session (mention-only guard)", async () => {
    // e.g. an orchestrator transcript that quoted the UUID in a dispatch
    // prompt: grep finds it, but its edits carry the orchestrator's own
    // source.session_id, not the queried UUID.
    const exec = twoStepExec(grepResponse([ENGRAM_SID]), {
      [ENGRAM_SID]: peekResponse([editEvent("/repo/src/a.ts", "some-other-uuid")]),
    });
    const r = await upgradeEvidence(UUID, BIN, exec, []);
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
    const r = await upgradeEvidence(UUID, BIN, exec, []);
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
    const r = await upgradeEvidence(UUID, BIN, exec, []);
    expect(r.matched).toBe(true);
    expect(r.citation).toContain(ENGRAM_SID);
    expect(r.citation).toContain("/repo/src/b.ts");
  });

  test("issues the exact grep and peek argv shapes", async () => {
    const calls: string[][] = [];
    const inner = twoStepExec(grepResponse([ENGRAM_SID]), {
      [ENGRAM_SID]: peekResponse([editEvent("/repo/src/a.ts", UUID)]),
    });
    const exec: Exec = async (argv) => {
      calls.push(argv);
      return inner(argv);
    };
    await upgradeEvidence(UUID, BIN, exec, []);
    expect(calls[0]).toEqual([BIN, "grep", UUID, "--limit", "3"]);
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
    const r = await upgradeEvidence(UUID, BIN, exec, []);
    expect(r.matched).toBe(true);
  });

  // Session ids come from transcripts (harness side) and engram output (grep
  // side) — both untrusted. Anything not matching the UUID/hex-hash
  // allowlist must be rejected before it can reach an argv.
  test("rejects hostile or malformed harness session ids without ever calling exec", async () => {
    for (const hostile of [
      "--help", "-x", "$(rm -rf /)", "", "a".repeat(65), "cc-p0; rm",
      // option-shaped values built only from allowlisted characters: all
      // dashes, or leading-dash with hex after — must still be rejected
      "--------", "-deadbeef0", "--dead-beef",
    ]) {
      let calls = 0;
      const spy: Exec = async () => {
        calls++;
        return { ok: true, stdout: "", stderr: "" };
      };
      const r = await upgradeEvidence(hostile, BIN, spy, []);
      expect(r.matched).toBe(false);
      expect(calls).toBe(0);
    }
  });

  test("citation is sanitized at assembly: no control chars, newlines, or angle brackets survive a hostile file path", async () => {
    const hostileFile = '/repo/<img src=x onerror=alert(1)>\n## Forged heading\t/thing_#1.ts';
    const exec = twoStepExec(grepResponse([ENGRAM_SID]), {
      [ENGRAM_SID]: peekResponse([editEvent(hostileFile, UUID)]),
    });
    const r = await upgradeEvidence(UUID, BIN, exec, []);
    expect(r.matched).toBe(true);
    // dangerous characters are gone entirely...
    expect(r.citation).not.toContain("<");
    expect(r.citation).not.toContain(">");
    expect(r.citation).not.toContain("\n");
    expect(r.citation).not.toContain("\t");
    // ...the "#" can no longer start a line (no newlines), and the
    // neutralized remainder still reads as a path
    expect(r.citation).toContain("img src=x");
    expect(r.citation).toContain("thing_#1.ts");
    expect(r.citation).toContain(ENGRAM_SID);
  });

  test("rejects a hostile engram session id from grep output without calling peek", async () => {
    const peeked: string[] = [];
    const inner = twoStepExec(grepResponse(["--------", "not hex!", ENGRAM_SID]), {
      [ENGRAM_SID]: peekResponse([editEvent("/repo/src/a.ts", UUID)]),
    });
    const exec: Exec = async (argv) => {
      if (argv[1] === "peek") peeked.push(argv[2]!);
      return inner(argv);
    };
    const r = await upgradeEvidence(UUID, BIN, exec, []);
    // the hostile candidates are skipped, the legitimate one still matches
    expect(r.matched).toBe(true);
    expect(peeked).toEqual([ENGRAM_SID]);
  });

  test("ignores grep sessions without a usable session_id instead of throwing", async () => {
    const exec = twoStepExec(
      cliStdout({ returned: 1, sessions: [{ confidence: 325.0 }] }), // no session_id key
      {},
    );
    const r = await upgradeEvidence(UUID, BIN, exec, []);
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
    const exec: Exec = async (argv) => {
      if (argv[1] === "peek") peeked.push(argv[2]!);
      return inner(argv);
    };
    const r = await upgradeEvidence(UUID, BIN, exec, []);
    expect(r.matched).toBe(false);
    expect(peeked).toEqual(["cafe0001", "cafe0002", "cafe0003"]);
  });

  test("a timed-out engram call (ok:false, empty stdout) degrades to no match", async () => {
    // The shape makeSpawnExec produces when the 5s per-call timeout kills a
    // hung binary (e.g. locked SQLite DB): non-zero/absent exit, nothing on
    // stdout. Evidence must stay untouched, never hang the report run.
    const timedOut: Exec = async () => ({ ok: false, stdout: "", stderr: "" });
    const r = await upgradeEvidence(UUID, BIN, timedOut, []);
    expect(r.matched).toBe(false);
  });

  test("never throws even if exec itself throws", async () => {
    const throwingExec: Exec = async () => {
      throw new Error("boom");
    };
    const r = await upgradeEvidence(UUID, BIN, throwingExec, []);
    expect(r.matched).toBe(false);
  });
});

// The connector's single entry point: owns the enabled switch, the
// newest-first sort, both query budgets, the default real exec, and the one
// fail-soft boundary. buildReport's per-profile loop calls only this.
describe("corroborateSessions", () => {
  const enabled = { enabled: true, binaryPath: BIN, beadPrefixes: [] };
  const disabled = { enabled: false, binaryPath: BIN, beadPrefixes: [] };

  const matchingExec = (uuid: string): Exec =>
    twoStepExec(grepResponse([ENGRAM_SID]), {
      [ENGRAM_SID]: peekResponse([editEvent("/repo/src/thing.ts", uuid)]),
    });

  test("returns no match without calling exec when the connector is disabled", async () => {
    let calls = 0;
    const spy: Exec = async () => {
      calls++;
      return { ok: true, stdout: "", stderr: "" };
    };
    const r = await corroborateSessions([rawSession(UUID, "2026-07-07T12:00:00.000Z")], disabled, { redactPatterns: [], exec: spy });
    expect(r.matched).toBe(false);
    expect(calls).toBe(0);
  });

  test("matches via an injected exec, returning the citation", async () => {
    const r = await corroborateSessions([rawSession(UUID, "2026-07-07T12:00:00.000Z")], enabled, { redactPatterns: [], exec: matchingExec(UUID) });
    expect(r.matched).toBe(true);
    expect(r.citation).toContain(ENGRAM_SID);
    expect(r.citation).toContain("/repo/src/thing.ts");
  });

  test("returns no match for an empty session list", async () => {
    const r = await corroborateSessions([], enabled, { redactPatterns: [], exec: matchingExec(UUID) });
    expect(r.matched).toBe(false);
  });

  test("tries sessions newest-first regardless of input order", async () => {
    const grepped: string[] = [];
    const spy: Exec = async (argv) => {
      if (argv[1] === "grep") grepped.push(argv[2]!);
      return { ok: true, stdout: JSON.stringify({ error: "no_results" }), stderr: "" };
    };
    const sessions = [
      rawSession("aaaa1111", "2026-07-07T10:00:00.000Z"), // oldest
      rawSession("cccc3333", "2026-07-07T12:00:00.000Z"), // newest
      rawSession("bbbb2222", "2026-07-07T11:00:00.000Z"),
    ];
    await corroborateSessions(sessions, enabled, { redactPatterns: [], exec: spy });
    expect(grepped).toEqual(["cccc3333", "bbbb2222", "aaaa1111"]);
  });

  test("greps at most 5 sessions per profile, even when more are supplied", async () => {
    const grepped: string[] = [];
    const spy: Exec = async (argv) => {
      if (argv[1] === "grep") grepped.push(argv[2]!);
      return { ok: true, stdout: JSON.stringify({ error: "no_results" }), stderr: "" };
    };
    // ascending start times; ids hex-shaped, newest are 7..3
    const sessions = Array.from({ length: 8 }, (_, i) =>
      rawSession(`aaaa000${i}`, `2026-07-07T0${i}:00:00.000Z`));
    const r = await corroborateSessions(sessions, enabled, { redactPatterns: [], exec: spy });
    expect(r.matched).toBe(false);
    expect(grepped).toEqual(["aaaa0007", "aaaa0006", "aaaa0005", "aaaa0004", "aaaa0003"]);
  });

  test("stops at the first matching session and doesn't keep querying afterward", async () => {
    const grepped: string[] = [];
    const exec: Exec = async (argv) => {
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
    const r = await corroborateSessions(sessions, enabled, { redactPatterns: [], exec });
    expect(r.matched).toBe(true);
    // newest-first: bbbb2222 misses, UUID matches, aaaa1111 never tried
    expect(grepped).toEqual(["bbbb2222", UUID]);
  });

  test("never throws even if exec throws (the single fail-soft boundary)", async () => {
    const throwingExec: Exec = async () => {
      throw new Error("boom");
    };
    const r = await corroborateSessions([rawSession(UUID, "2026-07-07T12:00:00.000Z")], enabled, { redactPatterns: [], exec: throwingExec });
    expect(r.matched).toBe(false);
  });

  test("with no injected exec and enabled=true, actually runs the binary (default real seam)", async () => {
    // The one deliberate semantic change from the review: enabled=true with
    // no injected seam runs engram for real instead of silently no-oping.
    // A nonexistent binary path exercises the default makeSpawnExec path and
    // degrades to no match, quickly and without throwing.
    const r = await corroborateSessions(
      [rawSession(UUID, "2026-07-07T12:00:00.000Z")],
      { enabled: true, binaryPath: "/no/such/binary-xyz", beadPrefixes: [] },
      { redactPatterns: [] },
    );
    expect(r.matched).toBe(false);
  });
});

// Dispatch-marker lineage: the dispatching party prepends `<engram-src
// id="<its own session uuid>"/>` to each dispatch prompt, so the marker
// lands verbatim at the START of the dispatched agent's transcript. The
// connector greps the marker LITERAL as it appears in a raw tape line
// (JSON-escaped quotes) — not the parent uuid, which live validation showed
// matches hundreds of unrelated tapes — then peeks each marker-carrying
// tape and classifies its inbound marker events: owned by another known
// session = a cross-session link, owned by the parent itself = an
// in-session subagent run (Task-tool transcripts inherit the parent's
// sessionId).
describe("discoverDispatchLinks", () => {
  const enabled = { enabled: true, binaryPath: BIN, beadPrefixes: [] };
  const disabled = { enabled: false, binaryPath: BIN, beadPrefixes: [] };

  const ORCH = "aaaa0000-0000-4000-8000-00000000000a"; // orchestrator (parent)
  const SUB = "bbbb0000-0000-4000-8000-00000000000b"; // subagent (child)
  const CHILD_TAPE = "2222222222222222222222222222222222222222222222222222222222222222";
  const RUN_TAPE = "3333333333333333333333333333333333333333333333333333333333333333";

  function lineageSession(sessionId: string, startedAt = "2026-07-07T12:00:00.000Z") {
    return { sessionId, startedAt };
  }

  // A dispatched agent's tape: its first inbound message BEGINS with the
  // dispatch marker (the spec prepends it to the handoff prompt). ownerUuid
  // is the session_id engram recorded for the transcript — another harness
  // session for a cross-session dispatch, the dispatching session itself
  // for a Task-tool subagent run.
  function markerEvent(
    markerUuid: string,
    ownerUuid: string,
    t = "2026-07-14T13:00:00.000Z",
    task = "implement the thing",
  ): unknown {
    return {
      k: "msg.in",
      role: "user",
      content: `<engram-src id="${markerUuid}"/> ${task}`,
      source: { harness: "claude-code", session_id: ownerUuid },
      t,
    };
  }

  // A tape QUOTING the marker in an outbound message (code review, echoed
  // fixture) — must never mint lineage regardless of owner.
  function sentMarkerEvent(markerUuid: string, ownerUuid: string): unknown {
    return {
      k: "msg.out",
      role: "assistant",
      content: [{ type: "toolCall", arguments: { prompt: `<engram-src id="${markerUuid}"/> do work` } }],
      source: { harness: "claude-code", session_id: ownerUuid },
      t: "2026-07-14T12:59:00.000Z",
    };
  }

  // Routes on the marker-literal grep query — the parent's own tape slices
  // never match it (the marker inside a tool-call prompt argument is nested
  // one JSON level deeper, so its quotes are double-escaped), which is why
  // realistic grep results contain only the dispatched side's tapes.
  const realisticExec: Exec = async (argv) => {
    if (argv[1] === "grep" && argv[2] === markerQuery(ORCH)) {
      return { ok: true, stdout: grepResponse([CHILD_TAPE]), stderr: "" };
    }
    if (argv[1] === "grep") return { ok: true, stdout: cliStdout({ error: "no_results" }), stderr: "" };
    if (argv[1] === "peek" && argv[2] === CHILD_TAPE) {
      return {
        ok: true,
        stdout: peekResponse([markerEvent(ORCH, SUB), editEvent("/repo/src/x.ts", SUB)]),
        stderr: "",
      };
    }
    return { ok: true, stdout: cliStdout({ error: "session_not_found" }), stderr: "" };
  };

  test("returns no links without calling exec when the connector is disabled", async () => {
    let calls = 0;
    const spy: Exec = async () => {
      calls++;
      return { ok: true, stdout: "", stderr: "" };
    };
    const r = await discoverDispatchLinks([lineageSession(ORCH), lineageSession(SUB)], disabled, spy);
    expect(r.links).toEqual([]);
    expect(r.runsByParent).toEqual([]);
    expect(calls).toBe(0);
  });

  test("a report with no linkable sessions never calls exec", async () => {
    let calls = 0;
    const spy: Exec = async () => {
      calls++;
      return { ok: true, stdout: cliStdout({ error: "no_results" }), stderr: "" };
    };
    expect((await discoverDispatchLinks([], enabled, spy)).links).toEqual([]);
    // shape-rejected ids alone leave nothing to probe
    expect((await discoverDispatchLinks([lineageSession("--help")], enabled, spy)).links).toEqual([]);
    expect(calls).toBe(0);
  });

  test("a single-session report still probes: in-session subagent runs don't need a second session", async () => {
    const exec: Exec = async (argv) => {
      if (argv[1] === "grep" && argv[2] === markerQuery(ORCH)) {
        return { ok: true, stdout: grepResponse([RUN_TAPE]), stderr: "" };
      }
      if (argv[1] === "grep") return { ok: true, stdout: cliStdout({ error: "no_results" }), stderr: "" };
      return { ok: true, stdout: peekResponse([markerEvent(ORCH, ORCH)]), stderr: "" };
    };
    const r = await discoverDispatchLinks([lineageSession(ORCH)], enabled, exec);
    expect(r.links).toEqual([]);
    expect(r.runsByParent).toEqual([{ parentSessionId: ORCH, runCount: 1 }]);
  });

  test("links parent to child when the child tape carries the parent's dispatch marker", async () => {
    const { links } = await discoverDispatchLinks([lineageSession(ORCH), lineageSession(SUB)], enabled, realisticExec);
    expect(links).toEqual([{ parentSessionId: ORCH, childSessionId: SUB }]);
  });

  test("issues the exact grep and peek argv shapes (marker literal as both query and filter)", async () => {
    const calls: string[][] = [];
    const exec: Exec = async (argv) => {
      calls.push(argv);
      return realisticExec(argv);
    };
    await discoverDispatchLinks([lineageSession(ORCH), lineageSession(SUB)], enabled, exec);
    expect(calls[0]).toEqual([BIN, "grep", markerQuery(ORCH), "--limit", "16"]);
    expect(calls[1]).toEqual([BIN, "peek", CHILD_TAPE, "--grep-filter", markerQuery(ORCH)]);
  });

  test("counts an in-session subagent run when the marker msg.in is owned by the parent itself", async () => {
    // Claude Code Task-tool subagent transcripts inherit the dispatching
    // session's sessionId, so engram records the run's events under the
    // parent's own uuid — a genuine dispatch with no session of its own.
    const exec: Exec = async (argv) => {
      if (argv[1] === "grep" && argv[2] === markerQuery(ORCH)) {
        return { ok: true, stdout: grepResponse([RUN_TAPE]), stderr: "" };
      }
      if (argv[1] === "grep") return { ok: true, stdout: cliStdout({ error: "no_results" }), stderr: "" };
      return { ok: true, stdout: peekResponse([markerEvent(ORCH, ORCH)]), stderr: "" };
    };
    const r = await discoverDispatchLinks([lineageSession(ORCH), lineageSession(SUB)], enabled, exec);
    expect(r.links).toEqual([]); // a self-owned run is never a self-LINK
    expect(r.runsByParent).toEqual([{ parentSessionId: ORCH, runCount: 1 }]);
  });

  test("in-session runs dedupe by inbound-message timestamp across tape slices, and distinct runs both count", async () => {
    const OTHER_RUN_TAPE = "4444444444444444444444444444444444444444444444444444444444444444";
    const exec: Exec = async (argv) => {
      if (argv[1] === "grep" && argv[2] === markerQuery(ORCH)) {
        return { ok: true, stdout: grepResponse([RUN_TAPE, OTHER_RUN_TAPE]), stderr: "" };
      }
      if (argv[1] === "grep") return { ok: true, stdout: cliStdout({ error: "no_results" }), stderr: "" };
      if (argv[2] === RUN_TAPE) {
        // the same run's msg.in repeated across two slices + a second run
        return {
          ok: true,
          stdout: peekResponse([
            markerEvent(ORCH, ORCH, "2026-07-14T13:00:00.000Z"),
            markerEvent(ORCH, ORCH, "2026-07-14T13:05:00.000Z"),
          ]),
          stderr: "",
        };
      }
      return { ok: true, stdout: peekResponse([markerEvent(ORCH, ORCH, "2026-07-14T13:00:00.000Z")]), stderr: "" };
    };
    const r = await discoverDispatchLinks([lineageSession(ORCH)], enabled, exec);
    expect(r.runsByParent).toEqual([{ parentSessionId: ORCH, runCount: 2 }]);
  });

  test("two distinct dispatches sharing a timestamp still count separately when their prompts differ", async () => {
    // Engram exposes no run/event id, so run identity is timestamp +
    // content: two dispatches recorded in the same instant are told apart
    // by their prompts. (Identical prompt + identical instant is the
    // documented residual collapse.)
    const exec: Exec = async (argv) => {
      if (argv[1] === "grep" && argv[2] === markerQuery(ORCH)) {
        return { ok: true, stdout: grepResponse([RUN_TAPE]), stderr: "" };
      }
      if (argv[1] === "grep") return { ok: true, stdout: cliStdout({ error: "no_results" }), stderr: "" };
      return {
        ok: true,
        stdout: peekResponse([
          markerEvent(ORCH, ORCH, "2026-07-14T13:00:00.000Z", "implement the thing"),
          markerEvent(ORCH, ORCH, "2026-07-14T13:00:00.000Z", "review the thing"),
        ]),
        stderr: "",
      };
    };
    const r = await discoverDispatchLinks([lineageSession(ORCH)], enabled, exec);
    expect(r.runsByParent).toEqual([{ parentSessionId: ORCH, runCount: 2 }]);
  });

  test("marker msg.in events with empty or garbage timestamps are skipped, never deduped on the junk", async () => {
    // An unusable timestamp can't anchor a run identity: counting it risks
    // overcounting slices, deduping on "" collapses distinct dispatches.
    // Skip is the honest move — and it must not disturb a valid sibling.
    const exec: Exec = async (argv) => {
      if (argv[1] === "grep" && argv[2] === markerQuery(ORCH)) {
        return { ok: true, stdout: grepResponse([RUN_TAPE]), stderr: "" };
      }
      if (argv[1] === "grep") return { ok: true, stdout: cliStdout({ error: "no_results" }), stderr: "" };
      return {
        ok: true,
        stdout: peekResponse([
          markerEvent(ORCH, ORCH, "", "first"),
          markerEvent(ORCH, ORCH, "", "second"),
          markerEvent(ORCH, ORCH, "definitely not a timestamp", "third"),
          markerEvent(ORCH, ORCH, "2026-99-99T99:99:99Z", "shape-valid but impossible instant"),
          markerEvent(ORCH, ORCH, "2026-07-14T13:00:00.000Z", "the one valid run"),
        ]),
        stderr: "",
      };
    };
    const r = await discoverDispatchLinks([lineageSession(ORCH)], enabled, exec);
    expect(r.runsByParent).toEqual([{ parentSessionId: ORCH, runCount: 1 }]);
  });

  test("a probe can report cross-session links and in-session runs side by side", async () => {
    const exec: Exec = async (argv) => {
      if (argv[1] === "grep" && argv[2] === markerQuery(ORCH)) {
        return { ok: true, stdout: grepResponse([CHILD_TAPE, RUN_TAPE]), stderr: "" };
      }
      if (argv[1] === "grep") return { ok: true, stdout: cliStdout({ error: "no_results" }), stderr: "" };
      if (argv[2] === CHILD_TAPE) return { ok: true, stdout: peekResponse([markerEvent(ORCH, SUB)]), stderr: "" };
      return { ok: true, stdout: peekResponse([markerEvent(ORCH, ORCH)]), stderr: "" };
    };
    const r = await discoverDispatchLinks([lineageSession(ORCH), lineageSession(SUB)], enabled, exec);
    expect(r.links).toEqual([{ parentSessionId: ORCH, childSessionId: SUB }]);
    expect(r.runsByParent).toEqual([{ parentSessionId: ORCH, runCount: 1 }]);
  });

  test("no link when grep finds nothing, errors, or returns malformed JSON", async () => {
    const noResults = execOk(cliStdout({ error: "no_results" }));
    expect((await discoverDispatchLinks([lineageSession(ORCH), lineageSession(SUB)], enabled, noResults)).links).toEqual([]);

    const malformed = execOk("config: /x\ndb: /y\nnot valid json{{{");
    expect((await discoverDispatchLinks([lineageSession(ORCH), lineageSession(SUB)], enabled, malformed)).links).toEqual([]);

    expect((await discoverDispatchLinks([lineageSession(ORCH), lineageSession(SUB)], enabled, execFail)).links).toEqual([]);
  });

  test("a timed-out engram call (ok:false, empty stdout) degrades to no links", async () => {
    const timedOut: Exec = async () => ({ ok: false, stdout: "", stderr: "" });
    expect((await discoverDispatchLinks([lineageSession(ORCH), lineageSession(SUB)], enabled, timedOut)).links).toEqual([]);
  });

  test("never throws even if exec itself throws", async () => {
    const throwingExec: Exec = async () => {
      throw new Error("boom");
    };
    expect((await discoverDispatchLinks([lineageSession(ORCH), lineageSession(SUB)], enabled, throwingExec)).links).toEqual([]);
  });

  test("no lineage when the marker names a session unknown to the report", async () => {
    // e.g. the dispatched agent's transcript isn't in today's report window:
    // the tape carries the marker, but its owner is unknown to ASL.
    const exec = twoStepExec(grepResponse([CHILD_TAPE]), {
      [CHILD_TAPE]: peekResponse([markerEvent(ORCH, "cccc0000-0000-4000-8000-00000000000c")]),
    });
    const r = await discoverDispatchLinks([lineageSession(ORCH), lineageSession(SUB)], enabled, exec);
    expect(r.links).toEqual([]);
    expect(r.runsByParent).toEqual([]);
  });

  test("no lineage when another session's events appear without the dispatch marker (mention-only guard)", async () => {
    // A tape whose returned lines never carry a marker-prefixed msg.in must
    // not be read as a dispatch.
    const exec = twoStepExec(grepResponse([CHILD_TAPE]), {
      [CHILD_TAPE]: peekResponse([editEvent("/repo/src/x.ts", SUB)]),
    });
    expect((await discoverDispatchLinks([lineageSession(ORCH), lineageSession(SUB)], enabled, exec)).links).toEqual([]);
  });

  test("duplicate discoveries collapse to one link", async () => {
    // Marker and child events repeated across several lines and both tapes.
    const exec: Exec = async (argv) => {
      if (argv[1] === "grep" && argv[2] === markerQuery(ORCH)) {
        return { ok: true, stdout: grepResponse([CHILD_TAPE, RUN_TAPE]), stderr: "" };
      }
      if (argv[1] === "grep") return { ok: true, stdout: cliStdout({ error: "no_results" }), stderr: "" };
      return {
        ok: true,
        stdout: peekResponse([markerEvent(ORCH, SUB), markerEvent(ORCH, SUB), editEvent("/x.ts", SUB)]),
        stderr: "",
      };
    };
    const { links } = await discoverDispatchLinks([lineageSession(ORCH), lineageSession(SUB)], enabled, exec);
    expect(links).toEqual([{ parentSessionId: ORCH, childSessionId: SUB }]);
  });

  // ── Same-event correlation guards ─────────────────────────────────────────
  // The marker text and the owning session_id must sit on the SAME parsed
  // tape event, and that event must be the dispatched side's inbound message
  // (k == "msg.in", the shape the dispatch prompt actually arrives as).
  // Anything looser mints false lineage from sessions that merely QUOTE the
  // marker, or from peek responses mixing lines of several sessions.

  test("no lineage when a session only discusses the marker in msg.out / tool.result events", async () => {
    // e.g. a code-review session pasting the dispatch prompt into its own
    // output, or a tool result echoing a test fixture containing the marker.
    // This is exactly what the marker-literal grep's residual false
    // positives look like: quoting tapes match the grep, then fail here.
    const quotingToolResult = {
      k: "tool.result",
      tool: "bash",
      stdout: `fixture says <engram-src id="${ORCH}"/> do work`,
      source: { harness: "claude-code", session_id: SUB },
      t: "2026-07-14T13:00:00.000Z",
    };
    const exec = twoStepExec(grepResponse([CHILD_TAPE]), {
      [CHILD_TAPE]: peekResponse([
        sentMarkerEvent(ORCH, SUB), // msg.out quoting the marker
        quotingToolResult,
      ]),
    });
    const r = await discoverDispatchLinks([lineageSession(ORCH), lineageSession(SUB)], enabled, exec);
    expect(r.links).toEqual([]);
    expect(r.runsByParent).toEqual([]);
  });

  test("a quoting msg.out owned by the parent itself never counts as an in-session run", async () => {
    const exec = twoStepExec(grepResponse([RUN_TAPE]), {
      [RUN_TAPE]: peekResponse([sentMarkerEvent(ORCH, ORCH)]),
    });
    const r = await discoverDispatchLinks([lineageSession(ORCH), lineageSession(SUB)], enabled, exec);
    expect(r.links).toEqual([]);
    expect(r.runsByParent).toEqual([]);
  });

  test("mixed-session peek response: only the session owning the marker event links, not context-line owners", async () => {
    const OTHER = "cccc0000-0000-4000-8000-00000000000c"; // also in the report
    const contextRead = {
      file: "/repo/src/read-only.ts",
      k: "code.read",
      source: { harness: "claude-code", session_id: OTHER }, // unrelated context line
      t: "2026-07-14T13:39:18.481Z",
    };
    const exec = twoStepExec(grepResponse([CHILD_TAPE]), {
      [CHILD_TAPE]: peekResponse([
        markerEvent(ORCH, SUB), // SUB owns the marker's inbound message
        contextRead,
      ]),
    });
    const { links } = await discoverDispatchLinks(
      [lineageSession(ORCH), lineageSession(SUB), lineageSession(OTHER)],
      enabled,
      exec,
    );
    expect(links).toEqual([{ parentSessionId: ORCH, childSessionId: SUB }]);
  });

  test("a tape whose events mix session ids never mints multi-child edges from one marker", async () => {
    const OTHER = "cccc0000-0000-4000-8000-00000000000c";
    const exec = twoStepExec(grepResponse([CHILD_TAPE]), {
      [CHILD_TAPE]: peekResponse([
        markerEvent(ORCH, SUB),
        // another known session's inbound message on the same tape, WITHOUT
        // the marker — must not become a second child of ORCH
        {
          k: "msg.in", role: "user", content: "unrelated task",
          source: { harness: "claude-code", session_id: OTHER },
          t: "2026-07-14T13:01:00.000Z",
        },
      ]),
    });
    const { links } = await discoverDispatchLinks(
      [lineageSession(ORCH), lineageSession(SUB), lineageSession(OTHER)],
      enabled,
      exec,
    );
    expect(links).toEqual([{ parentSessionId: ORCH, childSessionId: SUB }]);
  });

  // ── Marker escaping invariant (raw tape-line level) ───────────────────────
  // The whole probe design rests on one serialization fact: grep is a
  // literal substring search over RAW tape lines, and the queried literal
  // carries singly-escaped quotes (<engram-src id=\"uuid\"/>). That literal
  // must match the dispatched side's line — where the marker reached a
  // content STRING, so serializing the event escapes its quotes exactly
  // once — and must NOT match the dispatcher's own line, where the marker
  // sits inside a tool-call prompt argument recorded as JSON text, one JSON
  // level deeper, so its quotes double-escape in the raw line.

  test("the marker tape literal substring-matches the dispatched side's raw line, not the dispatcher's", async () => {
    // Dispatched side: a real serialized tape line for a direct msg.in
    // carrying the marker in its content string.
    const dispatchedLine = JSON.stringify(markerEvent(ORCH, SUB));
    // Dispatcher side: its transcript records the Task tool call with the
    // handoff prompt inside serialized JSON arguments — the marker's quotes
    // are already escaped once INSIDE the content string, then escaped
    // again when the event itself becomes a raw tape line.
    const dispatcherLine = JSON.stringify({
      k: "msg.out",
      role: "assistant",
      content: `Tool call: Task ${JSON.stringify({
        description: "implement the thing",
        prompt: `<engram-src id="${ORCH}"/> implement the thing`,
      })}`,
      source: { harness: "claude-code", session_id: ORCH },
      t: "2026-07-14T12:59:00.000Z",
    });

    const literal = markerQuery(ORCH); // <engram-src id=\"...\"/>, escaped quotes
    // Sanity: both raw lines mention the marker text itself...
    expect(dispatchedLine).toContain("<engram-src id=");
    expect(dispatcherLine).toContain("<engram-src id=");
    // ...but the singly-escaped literal selects only the dispatched side.
    expect(dispatchedLine).toContain(literal);
    expect(dispatcherLine).not.toContain(literal);
    // The dispatcher's copy sits one JSON level deeper: double-escaped.
    expect(dispatcherLine).toContain(`<engram-src id=\\\\\\"${ORCH}\\\\\\"/>`);
  });

  // ── Marker-prefix guard ────────────────────────────────────────────────────
  // A genuine dispatch PREPENDS the marker to the handoff message (engram
  // specs/core/dispatch-marker.md), so it must be a prefix of the parsed
  // msg.in content. A user pasting a dispatch prompt mid-message produces a
  // genuine msg.in with the marker text and the quoting session's own
  // session_id — prefix position is the only distinguishing signal available.

  test("no lineage when the marker sits mid-content in a msg.in (pasted dispatch prompt)", async () => {
    const pastedPrompt = {
      k: "msg.in",
      role: "user",
      content: `please review this dispatch prompt: <engram-src id="${ORCH}"/> implement the thing`,
      source: { harness: "claude-code", session_id: SUB },
      t: "2026-07-14T13:00:00.000Z",
    };
    const exec = twoStepExec(grepResponse([CHILD_TAPE]), {
      [CHILD_TAPE]: peekResponse([pastedPrompt]),
    });
    const r = await discoverDispatchLinks([lineageSession(ORCH), lineageSession(SUB)], enabled, exec);
    expect(r.links).toEqual([]);
    expect(r.runsByParent).toEqual([]);
  });

  test("marker at content start (after leading whitespace only) still links, with dispatch text following", async () => {
    const whitespacePrefixed = {
      k: "msg.in",
      role: "user",
      content: `\n  <engram-src id="${ORCH}"/> You are applying review findings to a branch. Work in the worktree.`,
      source: { harness: "claude-code", session_id: SUB },
      t: "2026-07-14T13:00:00.000Z",
    };
    const exec = twoStepExec(grepResponse([CHILD_TAPE]), {
      [CHILD_TAPE]: peekResponse([whitespacePrefixed]),
    });
    const { links } = await discoverDispatchLinks([lineageSession(ORCH), lineageSession(SUB)], enabled, exec);
    expect(links).toEqual([{ parentSessionId: ORCH, childSessionId: SUB }]);
  });

  test("no lineage when a msg.in has non-string content, even if a raw line mentions the marker", async () => {
    const structuredContent = {
      k: "msg.in",
      role: "user",
      content: [{ type: "text", text: `<engram-src id="${ORCH}"/> do work` }],
      source: { harness: "claude-code", session_id: SUB },
      t: "2026-07-14T13:00:00.000Z",
    };
    const exec = twoStepExec(grepResponse([CHILD_TAPE]), {
      [CHILD_TAPE]: peekResponse([structuredContent]),
    });
    expect((await discoverDispatchLinks([lineageSession(ORCH), lineageSession(SUB)], enabled, exec)).links).toEqual([]);
  });

  test("a marker on a raw non-event context line cannot vouch for a session named by other lines", async () => {
    // The marker must live on a PARSED msg.in event; a bare text line
    // carrying it correlates with nothing.
    const exec = twoStepExec(grepResponse([CHILD_TAPE]), {
      [CHILD_TAPE]: cliStdout({
        session: {
          content: [
            { line: 1, text: `context: <engram-src id="${ORCH}"/> quoted in passing` },
            { line: 2, text: JSON.stringify(editEvent("/repo/src/x.ts", SUB)) },
          ],
        },
      }),
    });
    expect((await discoverDispatchLinks([lineageSession(ORCH), lineageSession(SUB)], enabled, exec)).links).toEqual([]);
  });

  test("rejects hostile or malformed session ids without ever putting them in an argv", async () => {
    const argvSeen: string[] = [];
    const spy: Exec = async (argv) => {
      argvSeen.push(...argv.slice(2));
      return { ok: true, stdout: cliStdout({ error: "no_results" }), stderr: "" };
    };
    const hostiles = ["--help", "$(rm -rf /)", "", "--------", "-deadbeef0", "a".repeat(65)];
    await discoverDispatchLinks(
      [...hostiles.map((h) => lineageSession(h)), lineageSession(ORCH), lineageSession(SUB)],
      enabled,
      spy,
    );
    // hostile ids appear neither bare nor embedded in a marker query
    for (const h of hostiles.filter(Boolean)) expect(argvSeen.join("\n")).not.toContain(h);
    expect(argvSeen).toContain(markerQuery(ORCH));
  });

  test("rejects hostile tape ids from grep output without calling peek", async () => {
    const peeked: string[] = [];
    const exec: Exec = async (argv) => {
      if (argv[1] === "grep") {
        return argv[2] === markerQuery(ORCH)
          ? { ok: true, stdout: grepResponse(["--------", "not hex!", CHILD_TAPE]), stderr: "" }
          : { ok: true, stdout: cliStdout({ error: "no_results" }), stderr: "" };
      }
      peeked.push(argv[2]!);
      return { ok: true, stdout: peekResponse([markerEvent(ORCH, SUB)]), stderr: "" };
    };
    const { links } = await discoverDispatchLinks([lineageSession(ORCH), lineageSession(SUB)], enabled, exec);
    expect(peeked).toEqual([CHILD_TAPE]);
    expect(links).toEqual([{ parentSessionId: ORCH, childSessionId: SUB }]);
  });

  test("probes every window session newest-first — no report-wide session cap", async () => {
    // A session cap would silently skip the oldest orchestrators exactly on
    // busy multi-project days (the live-validation failure shape); a
    // non-dispatching session costs one no_results grep, so linear is the
    // honest budget.
    const grepped: string[] = [];
    const spy: Exec = async (argv) => {
      if (argv[1] === "grep") grepped.push(argv[2]!);
      return { ok: true, stdout: cliStdout({ error: "no_results" }), stderr: "" };
    };
    const sessions = Array.from({ length: 12 }, (_, i) =>
      lineageSession(`aaaa00${String(i).padStart(2, "0")}`, `2026-07-07T${String(i + 1).padStart(2, "0")}:00:00.000Z`));
    await discoverDispatchLinks(sessions, enabled, spy);
    expect(grepped.length).toBe(12);
    expect(grepped[0]).toBe(markerQuery("aaaa0011")); // newest first
    expect(grepped[11]).toBe(markerQuery("aaaa0000")); // oldest still probed
  });

  test("duplicate session ids in the window probe once and never overcount runs", async () => {
    // Claude Code Task-tool subagent transcripts inherit the dispatching
    // session's sessionId, and profile resolution doesn't dedupe sessions —
    // so the report window can legitimately carry the same id several
    // times. Each duplicate must not re-probe the parent (wasted greps) nor
    // mint another runsByParent entry (report.ts SUMS entries per profile,
    // so duplicates would double the rendered run count).
    const grepped: string[] = [];
    const exec: Exec = async (argv) => {
      if (argv[1] === "grep") {
        grepped.push(argv[2]!);
        return argv[2] === markerQuery(ORCH)
          ? { ok: true, stdout: grepResponse([RUN_TAPE]), stderr: "" }
          : { ok: true, stdout: cliStdout({ error: "no_results" }), stderr: "" };
      }
      return { ok: true, stdout: peekResponse([markerEvent(ORCH, ORCH)]), stderr: "" };
    };
    const r = await discoverDispatchLinks(
      [
        lineageSession(ORCH),
        lineageSession(ORCH, "2026-07-07T13:00:00.000Z"), // same id, later slice
        lineageSession(SUB),
      ],
      enabled,
      exec,
    );
    expect(grepped.filter((q) => q === markerQuery(ORCH)).length).toBe(1);
    expect(r.runsByParent).toEqual([{ parentSessionId: ORCH, runCount: 1 }]);
  });

  test("peeks at most 16 grep candidates per probed session (marker-tape cap)", async () => {
    const tapes = Array.from({ length: 18 }, (_, i) => `cafe${String(i + 1).padStart(4, "0")}`);
    const peeked: string[] = [];
    const exec: Exec = async (argv) => {
      if (argv[1] === "grep") return { ok: true, stdout: grepResponse(tapes), stderr: "" };
      peeked.push(argv[2]!);
      return { ok: true, stdout: peekResponse([]), stderr: "" };
    };
    await discoverDispatchLinks([lineageSession(ORCH)], enabled, exec);
    expect(peeked).toEqual(tapes.slice(0, 16));
  });

  // ── Truncation surfacing ───────────────────────────────────────────────────
  // grep reports its index-wide match count as `total`; when that exceeds
  // what the probe could peek (the --limit/cap), the discovered lineage may
  // be an undercount. That fact is surfaced per parent so the report can say
  // "list may be incomplete".

  test("reports a parent as truncated when grep's total exceeds the returned, capped candidates", async () => {
    const exec: Exec = async (argv) => {
      if (argv[1] === "grep" && argv[2] === markerQuery(ORCH)) {
        // grep honored --limit 16 but says 17 tapes matched index-wide
        return { ok: true, stdout: grepResponse([CHILD_TAPE], 17), stderr: "" };
      }
      if (argv[1] === "grep") return { ok: true, stdout: cliStdout({ error: "no_results" }), stderr: "" };
      return { ok: true, stdout: peekResponse([markerEvent(ORCH, SUB)]), stderr: "" };
    };
    const result = await discoverDispatchLinks([lineageSession(ORCH), lineageSession(SUB)], enabled, exec);
    expect(result.links).toEqual([{ parentSessionId: ORCH, childSessionId: SUB }]);
    expect(result.truncatedParents).toEqual([ORCH]);
  });

  test("a truncated parent is reported even when no candidate within the cap produced lineage", async () => {
    const tapes = Array.from({ length: 17 }, (_, i) => `cafe${String(i + 1).padStart(4, "0")}`);
    const exec: Exec = async (argv) => {
      if (argv[1] === "grep" && argv[2] === markerQuery(ORCH)) {
        return { ok: true, stdout: grepResponse(tapes), stderr: "" };
      }
      if (argv[1] === "grep") return { ok: true, stdout: cliStdout({ error: "no_results" }), stderr: "" };
      return { ok: true, stdout: peekResponse([]), stderr: "" };
    };
    const result = await discoverDispatchLinks([lineageSession(ORCH), lineageSession(SUB)], enabled, exec);
    expect(result.links).toEqual([]);
    expect(result.truncatedParents).toEqual([ORCH]);
  });

  test("no truncated parents when grep's total fits the cap", async () => {
    const result = await discoverDispatchLinks([lineageSession(ORCH), lineageSession(SUB)], enabled, realisticExec);
    expect(result.truncatedParents).toEqual([]);
  });

  test("a grep response without a total field, below the cap, never fabricates truncation", async () => {
    // Below the cap the returned list is necessarily complete: an older CLI
    // that omits `total` must not smear every probe as truncated.
    const exec: Exec = async (argv) => {
      if (argv[1] === "grep" && argv[2] === markerQuery(ORCH)) {
        return {
          ok: true,
          stdout: cliStdout({ sessions: [{ session_id: CHILD_TAPE, confidence: 1.0 }] }),
          stderr: "",
        };
      }
      if (argv[1] === "grep") return { ok: true, stdout: cliStdout({ error: "no_results" }), stderr: "" };
      return { ok: true, stdout: peekResponse([markerEvent(ORCH, SUB)]), stderr: "" };
    };
    const result = await discoverDispatchLinks([lineageSession(ORCH), lineageSession(SUB)], enabled, exec);
    expect(result.links).toEqual([{ parentSessionId: ORCH, childSessionId: SUB }]);
    expect(result.truncatedParents).toEqual([]);
  });

  test("a grep response without a total field that fills the cap is conservatively truncated", async () => {
    // Exactly 16 rows and no `total`: the list may have been cut exactly at
    // --limit, so "possibly incomplete" is the honest report — the opposite
    // guess would present partial lineage as the whole truth.
    const tapes = Array.from({ length: 16 }, (_, i) => `cafe${String(i + 1).padStart(4, "0")}`);
    const exec: Exec = async (argv) => {
      if (argv[1] === "grep" && argv[2] === markerQuery(ORCH)) {
        return {
          ok: true,
          stdout: cliStdout({ sessions: tapes.map((session_id) => ({ session_id, confidence: 1.0 })) }),
          stderr: "",
        };
      }
      if (argv[1] === "grep") return { ok: true, stdout: cliStdout({ error: "no_results" }), stderr: "" };
      return { ok: true, stdout: peekResponse([]), stderr: "" };
    };
    const result = await discoverDispatchLinks([lineageSession(ORCH), lineageSession(SUB)], enabled, exec);
    expect(result.truncatedParents).toEqual([ORCH]);
  });

  test("a parent with a 9-run fan-out reports every run: one deterministic grep, no ranking dependence", async () => {
    // The live shape that killed the parent-uuid probe (asl-9pd): 9 subagent
    // runs, each on its own tape, all owned by the parent's uuid. The
    // marker-literal grep returns exactly the marker-carrying tapes, so no
    // genuine dispatch can lose a ranking race against transcript noise.
    const tapes = Array.from({ length: 9 }, (_, i) => String(i + 1).repeat(64));
    const exec: Exec = async (argv) => {
      if (argv[1] === "grep" && argv[2] === markerQuery(ORCH)) {
        return { ok: true, stdout: grepResponse(tapes), stderr: "" };
      }
      if (argv[1] === "grep") return { ok: true, stdout: cliStdout({ error: "no_results" }), stderr: "" };
      const i = tapes.indexOf(argv[2]!);
      return {
        ok: true,
        stdout: peekResponse([markerEvent(ORCH, ORCH, `2026-07-15T0${i}:00:00.000Z`)]),
        stderr: "",
      };
    };
    const r = await discoverDispatchLinks([lineageSession(ORCH), lineageSession(SUB)], enabled, exec);
    expect(r.runsByParent).toEqual([{ parentSessionId: ORCH, runCount: 9 }]);
    expect(r.truncatedParents).toEqual([]);
  });

  test("a failing peek on one candidate doesn't stop the next candidate from linking", async () => {
    const exec: Exec = async (argv) => {
      if (argv[1] === "grep" && argv[2] === markerQuery(ORCH)) {
        return { ok: true, stdout: grepResponse([RUN_TAPE, CHILD_TAPE]), stderr: "" };
      }
      if (argv[1] === "grep") return { ok: true, stdout: cliStdout({ error: "no_results" }), stderr: "" };
      if (argv[2] === RUN_TAPE) return { ok: false, stdout: "", stderr: "boom" };
      return { ok: true, stdout: peekResponse([markerEvent(ORCH, SUB)]), stderr: "" };
    };
    const { links } = await discoverDispatchLinks([lineageSession(ORCH), lineageSession(SUB)], enabled, exec);
    expect(links).toEqual([{ parentSessionId: ORCH, childSessionId: SUB }]);
  });
});

// Task-key discovery (asl-1wm): bead IDs mentioned in a session's own
// dialogue, for TaskThread grouping. Reuses the evidence upgrade's query
// shape (grep the bare uuid, peek candidates) with a message-event filter
// and the same mention-only ownership guard; extracted tokens are strict
// prefix-allowlisted keys only, never quoted dialogue.
describe("findTaskKeys / discoverTaskKeys", () => {
  const PREFIXES = ["asl", "zzz"];
  const enabled = { enabled: true, binaryPath: BIN, beadPrefixes: PREFIXES };
  const disabled = { enabled: false, binaryPath: BIN, beadPrefixes: PREFIXES };
  const MSG_FILTER = '"k":"msg.';

  function msgEvent(kind: "msg.in" | "msg.out", content: string, ownerUuid: string): unknown {
    return {
      k: kind,
      role: kind === "msg.in" ? "user" : "assistant",
      content,
      source: { harness: "claude-code", session_id: ownerUuid },
      t: "2026-07-14T13:39:18.481Z",
    };
  }

  test("extracts allowlisted-prefix keys from msg.in and msg.out owned by the queried session, sorted and deduped", async () => {
    const exec = twoStepExec(grepResponse([ENGRAM_SID]), {
      [ENGRAM_SID]: peekResponse([
        msgEvent("msg.in", "please implement bead asl-1wm today", UUID),
        msgEvent("msg.out", "working asl-1wm; also touched zzz-9x8.", UUID),
      ]),
    });
    expect(await findTaskKeys(UUID, PREFIXES, BIN, exec, [])).toEqual(["asl-1wm", "zzz-9x8"]);
  });

  test("tokens outside the prefix allowlist never become keys (live-validated: generic shapes drown in hyphenated English)", async () => {
    const exec = twoStepExec(grepResponse([ENGRAM_SID]), {
      [ENGRAM_SID]: peekResponse([
        msgEvent("msg.in", "run apt-get, this is a one-off in-app fix for beads-xyz; also asl-1wm", UUID),
      ]),
    });
    expect(await findTaskKeys(UUID, PREFIXES, BIN, exec, [])).toEqual(["asl-1wm"]);
  });

  test("no configured prefixes disables the pass without calling exec", async () => {
    let calls = 0;
    const spy: Exec = async () => {
      calls++;
      return { ok: true, stdout: cliStdout({ error: "no_results" }), stderr: "" };
    };
    expect(await findTaskKeys(UUID, [], BIN, spy, [])).toEqual([]);
    const r = await discoverTaskKeys(
      [{ sessionId: UUID, startedAt: "2026-07-07T12:00:00.000Z" }],
      { enabled: true, binaryPath: BIN, beadPrefixes: [] },
      { redactPatterns: [], exec: spy },
    );
    expect(r.size).toBe(0);
    expect(calls).toBe(0);
  });

  test("rejects mention-only events (another session's dialogue must not donate keys)", async () => {
    const exec = twoStepExec(grepResponse([ENGRAM_SID]), {
      [ENGRAM_SID]: peekResponse([msgEvent("msg.in", "quoting asl-1wm here", "some-other-uuid")]),
    });
    expect(await findTaskKeys(UUID, PREFIXES, BIN, exec, [])).toEqual([]);
  });

  test("ignores non-message events and non-string content", async () => {
    const exec = twoStepExec(grepResponse([ENGRAM_SID]), {
      [ENGRAM_SID]: peekResponse([
        { k: "code.edit", file: "/repo/asl-1wm.ts", source: { session_id: UUID }, t: "t" },
        { k: "msg.in", content: [{ type: "text", text: "asl-1wm" }], source: { session_id: UUID }, t: "t" },
      ]),
    });
    expect(await findTaskKeys(UUID, PREFIXES, BIN, exec, [])).toEqual([]);
  });

  test("composite tokens never shed a false key: markers, worktree names, branch names", async () => {
    const exec = twoStepExec(grepResponse([ENGRAM_SID]), {
      [ENGRAM_SID]: peekResponse([
        msgEvent(
          "msg.in",
          `<engram-src id="${UUID}"/> work in asl-wt-1wm on branch asl-1wm-task-threads`,
          UUID,
        ),
      ]),
    });
    // "asl-wt" (trailing dash), "wt-1wm" (leading dash, foreign prefix) and
    // "asl-1wm" embedded dash-adjacent in the branch name are all rejected
    // by the boundary rules; nothing here is a clean bead mention.
    expect(await findTaskKeys(UUID, PREFIXES, BIN, exec, [])).toEqual([]);
  });

  test("drops a key a redact pattern would alter (fail closed) instead of surfacing or mangling it", async () => {
    const exec = twoStepExec(grepResponse([ENGRAM_SID]), {
      [ENGRAM_SID]: peekResponse([msgEvent("msg.in", "work on asl-1wm and zzz-4u2", UUID)]),
    });
    expect(await findTaskKeys(UUID, PREFIXES, BIN, exec, ["zzz-\\w+"])).toEqual(["asl-1wm"]);
  });

  test("reads every grep candidate up to the cap (tape slices can split the dialogue)", async () => {
    const otherSlice = "1111111111111111111111111111111111111111111111111111111111111111";
    const exec = twoStepExec(grepResponse([ENGRAM_SID, otherSlice]), {
      [ENGRAM_SID]: peekResponse([msgEvent("msg.in", "start asl-1wm", UUID)]),
      [otherSlice]: peekResponse([msgEvent("msg.out", "finish asl-9pd", UUID)]),
    });
    expect(await findTaskKeys(UUID, PREFIXES, BIN, exec, [])).toEqual(["asl-1wm", "asl-9pd"]);
  });

  test("issues the exact grep and peek argv shapes (message filter)", async () => {
    const calls: string[][] = [];
    const inner = twoStepExec(grepResponse([ENGRAM_SID]), {
      [ENGRAM_SID]: peekResponse([msgEvent("msg.in", "asl-1wm", UUID)]),
    });
    const exec: Exec = async (argv) => {
      calls.push(argv);
      return inner(argv);
    };
    await findTaskKeys(UUID, PREFIXES, BIN, exec, []);
    expect(calls[0]).toEqual([BIN, "grep", UUID, "--limit", "3"]);
    expect(calls[1]).toEqual([BIN, "peek", ENGRAM_SID, "--grep-filter", MSG_FILTER]);
  });

  test("never throws: hostile uuid, failing exec, malformed JSON all yield no keys", async () => {
    expect(await findTaskKeys("--help", PREFIXES, BIN, execFail, [])).toEqual([]);
    expect(await findTaskKeys(UUID, PREFIXES, BIN, execFail, [])).toEqual([]);
    expect(await findTaskKeys(UUID, PREFIXES, BIN, execOk("garbage{{"), [])).toEqual([]);
  });

  test("discoverTaskKeys: disabled connector returns an empty map without calling exec", async () => {
    let calls = 0;
    const spy: Exec = async () => {
      calls++;
      return { ok: true, stdout: cliStdout({ error: "no_results" }), stderr: "" };
    };
    const r = await discoverTaskKeys([{ sessionId: UUID, startedAt: "2026-07-07T12:00:00.000Z" }], disabled, {
      redactPatterns: [], exec: spy,
    });
    expect(r.size).toBe(0);
    expect(calls).toBe(0);
  });

  test("discoverTaskKeys: probes newest-first, once per session id, and maps only key-bearing sessions", async () => {
    const OTHER = "bbbb0000-0000-4000-8000-00000000000b";
    const grepped: string[] = [];
    const exec: Exec = async (argv) => {
      if (argv[1] === "grep") {
        grepped.push(argv[2]!);
        if (argv[2] === UUID) return { ok: true, stdout: grepResponse([ENGRAM_SID]), stderr: "" };
        return { ok: true, stdout: cliStdout({ error: "no_results" }), stderr: "" };
      }
      return { ok: true, stdout: peekResponse([msgEvent("msg.in", "on asl-1wm", UUID)]), stderr: "" };
    };
    const r = await discoverTaskKeys(
      [
        { sessionId: UUID, startedAt: "2026-07-07T11:00:00.000Z" },
        { sessionId: OTHER, startedAt: "2026-07-07T12:00:00.000Z" },
        { sessionId: UUID, startedAt: "2026-07-07T13:00:00.000Z" }, // duplicate id: probed once
      ],
      enabled,
      { redactPatterns: [], exec },
    );
    expect(grepped).toEqual([UUID, OTHER]); // duplicate skipped; newest first
    expect(r.get(UUID)).toEqual(["asl-1wm"]);
    expect(r.has(OTHER)).toBe(false); // no keys → no entry
  });
});
