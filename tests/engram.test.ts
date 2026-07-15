import { describe, expect, test } from "bun:test";
import { corroborateSessions, discoverDispatchLinks, upgradeEvidence } from "../src/connectors/engram";
import type { Exec } from "../src/exec";
import {
  BIN, ENGRAM_SID, UUID,
  cliStdout, editEvent, grepResponse, peekResponse, rawSession, twoStepExec,
} from "./helpers/engram-fixtures";

const execOk =
  (stdout: string): Exec =>
  () => ({ ok: true, stdout, stderr: "" });
const execFail: Exec = () => ({ ok: false, stdout: "", stderr: "not found" });

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
    const exec: Exec = (argv) => {
      calls.push(argv);
      return inner(argv);
    };
    await upgradeEvidence(UUID, BIN, exec, []);
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
    const r = await upgradeEvidence(UUID, BIN, exec, []);
    expect(r.matched).toBe(true);
  });

  // Session ids come from transcripts (harness side) and engram output (grep
  // side) — both untrusted. Anything not matching the UUID/hex-hash
  // allowlist must be rejected before it can reach an argv.
  test("rejects hostile or malformed harness session ids without ever calling exec", () => {
    for (const hostile of [
      "--help", "-x", "$(rm -rf /)", "", "a".repeat(65), "cc-p0; rm",
      // option-shaped values built only from allowlisted characters: all
      // dashes, or leading-dash with hex after — must still be rejected
      "--------", "-deadbeef0", "--dead-beef",
    ]) {
      let calls = 0;
      const spy: Exec = () => {
        calls++;
        return { ok: true, stdout: "", stderr: "" };
      };
      const r = upgradeEvidence(hostile, BIN, spy, []);
      expect(r.matched).toBe(false);
      expect(calls).toBe(0);
    }
  });

  test("citation is sanitized at assembly: no control chars, newlines, or angle brackets survive a hostile file path", () => {
    const hostileFile = '/repo/<img src=x onerror=alert(1)>\n## Forged heading\t/thing_#1.ts';
    const exec = twoStepExec(grepResponse([ENGRAM_SID]), {
      [ENGRAM_SID]: peekResponse([editEvent(hostileFile, UUID)]),
    });
    const r = upgradeEvidence(UUID, BIN, exec, []);
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

  test("rejects a hostile engram session id from grep output without calling peek", () => {
    const peeked: string[] = [];
    const inner = twoStepExec(grepResponse(["--------", "not hex!", ENGRAM_SID]), {
      [ENGRAM_SID]: peekResponse([editEvent("/repo/src/a.ts", UUID)]),
    });
    const exec: Exec = (argv) => {
      if (argv[1] === "peek") peeked.push(argv[2]!);
      return inner(argv);
    };
    const r = upgradeEvidence(UUID, BIN, exec, []);
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
    const exec: Exec = (argv) => {
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
    const timedOut: Exec = () => ({ ok: false, stdout: "", stderr: "" });
    const r = await upgradeEvidence(UUID, BIN, timedOut, []);
    expect(r.matched).toBe(false);
  });

  test("never throws even if exec itself throws", async () => {
    const throwingExec: Exec = () => {
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
  const enabled = { enabled: true, binaryPath: BIN };
  const disabled = { enabled: false, binaryPath: BIN };

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
    const r = corroborateSessions([rawSession(UUID, "2026-07-07T12:00:00.000Z")], disabled, { redactPatterns: [], exec: spy });
    expect(r.matched).toBe(false);
    expect(calls).toBe(0);
  });

  test("matches via an injected exec, returning the citation", () => {
    const r = corroborateSessions([rawSession(UUID, "2026-07-07T12:00:00.000Z")], enabled, { redactPatterns: [], exec: matchingExec(UUID) });
    expect(r.matched).toBe(true);
    expect(r.citation).toContain(ENGRAM_SID);
    expect(r.citation).toContain("/repo/src/thing.ts");
  });

  test("returns no match for an empty session list", () => {
    const r = corroborateSessions([], enabled, { redactPatterns: [], exec: matchingExec(UUID) });
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
    corroborateSessions(sessions, enabled, { redactPatterns: [], exec: spy });
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
    const r = corroborateSessions(sessions, enabled, { redactPatterns: [], exec: spy });
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
    const r = corroborateSessions(sessions, enabled, { redactPatterns: [], exec });
    expect(r.matched).toBe(true);
    // newest-first: bbbb2222 misses, UUID matches, aaaa1111 never tried
    expect(grepped).toEqual(["bbbb2222", UUID]);
  });

  test("never throws even if exec throws (the single fail-soft boundary)", () => {
    const throwingExec: Exec = () => {
      throw new Error("boom");
    };
    const r = corroborateSessions([rawSession(UUID, "2026-07-07T12:00:00.000Z")], enabled, { redactPatterns: [], exec: throwingExec });
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
      { redactPatterns: [] },
    );
    expect(r.matched).toBe(false);
  });
});

// Dispatch-marker lineage: an orchestrator prepends `<engram-src id="<its
// own session uuid>"/>` to each dispatch prompt, so the marker text lands
// verbatim in the subagent's transcript. The connector greps the parent's
// uuid, peeks the candidate tapes, and links parent → child when a tape
// carries the marker AND its events belong to another known report session.
describe("discoverDispatchLinks", () => {
  const enabled = { enabled: true, binaryPath: BIN };
  const disabled = { enabled: false, binaryPath: BIN };

  const ORCH = "aaaa0000-0000-4000-8000-00000000000a"; // orchestrator (parent)
  const SUB = "bbbb0000-0000-4000-8000-00000000000b"; // subagent (child)
  const PARENT_TAPE = "1111111111111111111111111111111111111111111111111111111111111111";
  const CHILD_TAPE = "2222222222222222222222222222222222222222222222222222222222222222";

  function lineageSession(sessionId: string, startedAt = "2026-07-07T12:00:00.000Z") {
    return { sessionId, startedAt };
  }

  // The subagent's tape: its first user message carries the dispatch marker
  // (quotes JSON-escaped inside the raw tape line, as peek returns them),
  // and every event carries the subagent's own source.session_id block.
  function markerEvent(markerUuid: string, ownerUuid: string): unknown {
    return {
      k: "msg.in",
      role: "user",
      content: `<engram-src id="${markerUuid}"/> implement the thing`,
      source: { harness: "claude-code", session_id: ownerUuid },
      t: "2026-07-14T13:00:00.000Z",
    };
  }

  // The orchestrator's own tape: the marker sits inside a toolCall payload
  // and all events carry the orchestrator's source.session_id — it must
  // never self-link.
  function sentMarkerEvent(markerUuid: string, ownerUuid: string): unknown {
    return {
      k: "msg.out",
      role: "assistant",
      content: [{ type: "toolCall", arguments: { prompt: `<engram-src id="${markerUuid}"/> do work` } }],
      source: { harness: "claude-code", session_id: ownerUuid },
      t: "2026-07-14T12:59:00.000Z",
    };
  }

  const realisticExec: Exec = (argv) => {
    if (argv[1] === "grep" && argv[2] === ORCH) {
      return { ok: true, stdout: grepResponse([PARENT_TAPE, CHILD_TAPE]), stderr: "" };
    }
    if (argv[1] === "grep") return { ok: true, stdout: cliStdout({ error: "no_results" }), stderr: "" };
    if (argv[1] === "peek" && argv[2] === PARENT_TAPE) {
      return { ok: true, stdout: peekResponse([sentMarkerEvent(ORCH, ORCH)]), stderr: "" };
    }
    if (argv[1] === "peek" && argv[2] === CHILD_TAPE) {
      return {
        ok: true,
        stdout: peekResponse([markerEvent(ORCH, SUB), editEvent("/repo/src/x.ts", SUB)]),
        stderr: "",
      };
    }
    return { ok: true, stdout: cliStdout({ error: "session_not_found" }), stderr: "" };
  };

  test("returns no links without calling exec when the connector is disabled", () => {
    let calls = 0;
    const spy: Exec = () => {
      calls++;
      return { ok: true, stdout: "", stderr: "" };
    };
    const links = discoverDispatchLinks([lineageSession(ORCH), lineageSession(SUB)], disabled, spy);
    expect(links).toEqual([]);
    expect(calls).toBe(0);
  });

  test("links parent to child when the child tape carries the parent's dispatch marker", () => {
    const links = discoverDispatchLinks([lineageSession(ORCH), lineageSession(SUB)], enabled, realisticExec);
    expect(links).toEqual([{ parentSessionId: ORCH, childSessionId: SUB }]);
  });

  test("issues the exact grep and peek argv shapes (peek filtered by the parent uuid)", () => {
    const calls: string[][] = [];
    const exec: Exec = (argv) => {
      calls.push(argv);
      return realisticExec(argv);
    };
    discoverDispatchLinks([lineageSession(ORCH)], enabled, exec);
    expect(calls[0]).toEqual([BIN, "grep", ORCH]);
    expect(calls[1]).toEqual([BIN, "peek", PARENT_TAPE, "--grep-filter", ORCH]);
    expect(calls[2]).toEqual([BIN, "peek", CHILD_TAPE, "--grep-filter", ORCH]);
  });

  test("no link when grep finds nothing, errors, or returns malformed JSON", () => {
    const noResults = execOk(cliStdout({ error: "no_results" }));
    expect(discoverDispatchLinks([lineageSession(ORCH)], enabled, noResults)).toEqual([]);

    const malformed = execOk("config: /x\ndb: /y\nnot valid json{{{");
    expect(discoverDispatchLinks([lineageSession(ORCH)], enabled, malformed)).toEqual([]);

    expect(discoverDispatchLinks([lineageSession(ORCH)], enabled, execFail)).toEqual([]);
  });

  test("a timed-out engram call (ok:false, empty stdout) degrades to no links", () => {
    const timedOut: Exec = () => ({ ok: false, stdout: "", stderr: "" });
    expect(discoverDispatchLinks([lineageSession(ORCH)], enabled, timedOut)).toEqual([]);
  });

  test("never throws even if exec itself throws", () => {
    const throwingExec: Exec = () => {
      throw new Error("boom");
    };
    expect(discoverDispatchLinks([lineageSession(ORCH)], enabled, throwingExec)).toEqual([]);
  });

  test("no link when the marker is present but the tape's events belong to no other known session", () => {
    // e.g. the dispatched agent's transcript isn't in today's report window:
    // the tape carries the marker, but its session_id is unknown to ASL.
    const exec = twoStepExec(grepResponse([CHILD_TAPE]), {
      [CHILD_TAPE]: peekResponse([markerEvent(ORCH, "cccc0000-0000-4000-8000-00000000000c")]),
    });
    expect(discoverDispatchLinks([lineageSession(ORCH), lineageSession(SUB)], enabled, exec)).toEqual([]);
  });

  test("no link when another session's events appear without the dispatch marker (mention-only guard)", () => {
    // A tape that merely mentions the parent uuid (no <engram-src .../>)
    // must not be read as a dispatch.
    const exec = twoStepExec(grepResponse([CHILD_TAPE]), {
      [CHILD_TAPE]: peekResponse([editEvent("/repo/src/x.ts", SUB)]),
    });
    expect(discoverDispatchLinks([lineageSession(ORCH), lineageSession(SUB)], enabled, exec)).toEqual([]);
  });

  test("the orchestrator's own tape never produces a self-link", () => {
    const exec = twoStepExec(grepResponse([PARENT_TAPE]), {
      [PARENT_TAPE]: peekResponse([sentMarkerEvent(ORCH, ORCH)]),
    });
    expect(discoverDispatchLinks([lineageSession(ORCH), lineageSession(SUB)], enabled, exec)).toEqual([]);
  });

  test("duplicate discoveries collapse to one link", () => {
    // Marker and child events repeated across several lines and both tapes.
    const exec: Exec = (argv) => {
      if (argv[1] === "grep" && argv[2] === ORCH) {
        return { ok: true, stdout: grepResponse([PARENT_TAPE, CHILD_TAPE]), stderr: "" };
      }
      if (argv[1] === "grep") return { ok: true, stdout: cliStdout({ error: "no_results" }), stderr: "" };
      return {
        ok: true,
        stdout: peekResponse([markerEvent(ORCH, SUB), markerEvent(ORCH, SUB), editEvent("/x.ts", SUB)]),
        stderr: "",
      };
    };
    const links = discoverDispatchLinks([lineageSession(ORCH), lineageSession(SUB)], enabled, exec);
    expect(links).toEqual([{ parentSessionId: ORCH, childSessionId: SUB }]);
  });

  // ── Same-event correlation guards ─────────────────────────────────────────
  // The marker text and the child session_id must sit on the SAME parsed
  // tape event, and that event must be the subagent's inbound message
  // (k == "msg.in", the shape the dispatch prompt actually arrives as).
  // Anything looser mints false edges from sessions that merely QUOTE the
  // marker, or from peek responses mixing lines of several sessions.

  test("no edge when a session only discusses the marker in msg.out / tool.result events", () => {
    // e.g. a code-review session pasting the dispatch prompt into its own
    // output, or a tool result echoing a test fixture containing the marker.
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
    expect(discoverDispatchLinks([lineageSession(ORCH), lineageSession(SUB)], enabled, exec)).toEqual([]);
  });

  test("mixed-session peek response: only the session owning the marker event links, not context-line owners", () => {
    const OTHER = "cccc0000-0000-4000-8000-00000000000c"; // also in the report
    const exec = twoStepExec(grepResponse([CHILD_TAPE]), {
      [CHILD_TAPE]: peekResponse([
        markerEvent(ORCH, SUB), // SUB owns the marker's inbound message
        { ...readEvent, source: { harness: "claude-code", session_id: OTHER } }, // unrelated context line
      ]),
    });
    const links = discoverDispatchLinks(
      [lineageSession(ORCH), lineageSession(SUB), lineageSession(OTHER)],
      enabled,
      exec,
    );
    expect(links).toEqual([{ parentSessionId: ORCH, childSessionId: SUB }]);
  });

  test("a tape whose events mix session ids never mints multi-child edges from one marker", () => {
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
    const links = discoverDispatchLinks(
      [lineageSession(ORCH), lineageSession(SUB), lineageSession(OTHER)],
      enabled,
      exec,
    );
    expect(links).toEqual([{ parentSessionId: ORCH, childSessionId: SUB }]);
  });

  test("a marker on a raw non-event context line cannot vouch for a session named by other lines", () => {
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
    expect(discoverDispatchLinks([lineageSession(ORCH), lineageSession(SUB)], enabled, exec)).toEqual([]);
  });

  test("rejects hostile or malformed session ids without ever putting them in an argv", () => {
    const argvSeen: string[] = [];
    const spy: Exec = (argv) => {
      argvSeen.push(...argv.slice(2));
      return { ok: true, stdout: cliStdout({ error: "no_results" }), stderr: "" };
    };
    const hostiles = ["--help", "$(rm -rf /)", "", "--------", "-deadbeef0", "a".repeat(65)];
    discoverDispatchLinks(
      [...hostiles.map((h) => lineageSession(h)), lineageSession(ORCH)],
      enabled,
      spy,
    );
    for (const h of hostiles) expect(argvSeen).not.toContain(h);
    expect(argvSeen).toContain(ORCH);
  });

  test("rejects hostile tape ids from grep output without calling peek", () => {
    const peeked: string[] = [];
    const exec: Exec = (argv) => {
      if (argv[1] === "grep") {
        return argv[2] === ORCH
          ? { ok: true, stdout: grepResponse(["--------", "not hex!", CHILD_TAPE]), stderr: "" }
          : { ok: true, stdout: cliStdout({ error: "no_results" }), stderr: "" };
      }
      peeked.push(argv[2]!);
      return { ok: true, stdout: peekResponse([markerEvent(ORCH, SUB)]), stderr: "" };
    };
    const links = discoverDispatchLinks([lineageSession(ORCH), lineageSession(SUB)], enabled, exec);
    expect(peeked).toEqual([CHILD_TAPE]);
    expect(links).toEqual([{ parentSessionId: ORCH, childSessionId: SUB }]);
  });

  test("probes sessions newest-first and stops at the report-wide budget of 10", () => {
    const grepped: string[] = [];
    const spy: Exec = (argv) => {
      if (argv[1] === "grep") grepped.push(argv[2]!);
      return { ok: true, stdout: cliStdout({ error: "no_results" }), stderr: "" };
    };
    const sessions = Array.from({ length: 12 }, (_, i) =>
      lineageSession(`aaaa00${String(i).padStart(2, "0")}`, `2026-07-07T${String(i + 1).padStart(2, "0")}:00:00.000Z`));
    discoverDispatchLinks(sessions, enabled, spy);
    expect(grepped.length).toBe(10);
    expect(grepped[0]).toBe("aaaa0011"); // newest first
    expect(grepped[9]).toBe("aaaa0002");
  });

  test("peeks at most 3 grep candidates per probed session", () => {
    const tapes = ["cafe0001", "cafe0002", "cafe0003", "cafe0004", "cafe0005"];
    const peeked: string[] = [];
    const exec: Exec = (argv) => {
      if (argv[1] === "grep") return { ok: true, stdout: grepResponse(tapes), stderr: "" };
      peeked.push(argv[2]!);
      return { ok: true, stdout: peekResponse([]), stderr: "" };
    };
    discoverDispatchLinks([lineageSession(ORCH)], enabled, exec);
    expect(peeked).toEqual(["cafe0001", "cafe0002", "cafe0003"]);
  });

  test("a failing peek on one candidate doesn't stop the next candidate from linking", () => {
    const exec: Exec = (argv) => {
      if (argv[1] === "grep" && argv[2] === ORCH) {
        return { ok: true, stdout: grepResponse([PARENT_TAPE, CHILD_TAPE]), stderr: "" };
      }
      if (argv[1] === "grep") return { ok: true, stdout: cliStdout({ error: "no_results" }), stderr: "" };
      if (argv[2] === PARENT_TAPE) return { ok: false, stdout: "", stderr: "boom" };
      return { ok: true, stdout: peekResponse([markerEvent(ORCH, SUB)]), stderr: "" };
    };
    const links = discoverDispatchLinks([lineageSession(ORCH), lineageSession(SUB)], enabled, exec);
    expect(links).toEqual([{ parentSessionId: ORCH, childSessionId: SUB }]);
  });
});
