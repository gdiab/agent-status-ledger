// Conversation signals (asl-cey): work-vs-think classification from
// message/edit ratios and tool-call density, plus the awaited question
// quoted — through the sanitizeTapeText choke point — from the final
// msg.out. Signals are one fold of the shared owned-dialogue walk
// (findDialogueFacts): ONE grep of the bare uuid + peeks with the widest
// kind filter serve both the signal fold and the task-key fold, with the
// same mention-only ownership guard applied at the walk.
import { describe, expect, test } from "bun:test";
import { discoverDialogueFacts, findDialogueFacts, type ConversationSignal } from "../src/connectors/engram";
import type { Exec } from "../src/exec";
import {
  BIN, ENGRAM_SID, UUID,
  cliStdout, editEvent, grepResponse, peekResponse, twoStepExec,
} from "./helpers/engram-fixtures";

const EVENT_FILTER = '"k":"';

const execOk =
  (stdout: string): Exec =>
  async () => ({ ok: true, stdout, stderr: "" });
const execFail: Exec = async () => ({ ok: false, stdout: "", stderr: "not found" });

// The signal fold's view of one session, through the shared dialogue walk
// (no bead prefixes: only the signal side of the walk's output matters here;
// the key fold's own tests live in engram.test.ts).
async function findConversationSignal(
  sessionUuid: string,
  binaryPath: string,
  exec: Exec,
  extraPatterns: string[],
): Promise<ConversationSignal | undefined> {
  return (await findDialogueFacts(sessionUuid, [], binaryPath, exec, extraPatterns)).signal;
}

function msgEvent(
  kind: "msg.in" | "msg.out",
  content: string,
  ownerUuid: string,
  t = "2026-07-14T13:00:00.000Z",
): unknown {
  return {
    k: kind,
    role: kind === "msg.in" ? "user" : "assistant",
    content,
    source: { harness: "claude-code", session_id: ownerUuid },
    t,
  };
}

function toolEvent(ownerUuid: string, t = "2026-07-14T13:00:00.000Z"): unknown {
  return {
    k: "tool.call", tool: "bash", args: { command: "bun test" },
    source: { harness: "claude-code", session_id: ownerUuid },
    t,
  };
}

const sessionExec = (events: unknown[]): Exec =>
  twoStepExec(grepResponse([ENGRAM_SID]), { [ENGRAM_SID]: peekResponse(events) });

describe("findDialogueFacts — classification", () => {
  test("dialogue-only session classifies as thinking", async () => {
    const exec = sessionExec([
      msgEvent("msg.in", "how should I structure the migration?", UUID),
      msgEvent("msg.out", "There are two viable shapes...", UUID),
      msgEvent("msg.in", "what about rollback?", UUID),
      msgEvent("msg.out", "Rollback favors the second shape.", UUID),
    ]);
    const s = await findConversationSignal(UUID, BIN, exec, []);
    expect(s?.kind).toBe("thinking");
  });

  test("any owned code.edit makes the session build, regardless of message volume", async () => {
    const exec = sessionExec([
      msgEvent("msg.in", "please fix the bug", UUID),
      msgEvent("msg.out", "on it", UUID),
      editEvent("/repo/src/a.ts", UUID),
    ]);
    const s = await findConversationSignal(UUID, BIN, exec, []);
    expect(s?.kind).toBe("build");
  });

  test("edit-free but tool-dense session is build (running tests/commands is work)", async () => {
    const exec = sessionExec([
      msgEvent("msg.in", "run the suite and triage", UUID),
      toolEvent(UUID, "2026-07-14T13:01:00.000Z"),
      toolEvent(UUID, "2026-07-14T13:02:00.000Z"),
      msgEvent("msg.out", "two failures, both in redact", UUID),
    ]);
    const s = await findConversationSignal(UUID, BIN, exec, []);
    expect(s?.kind).toBe("build"); // 2 tools / 2 messages = 1.0 density
  });

  test("an occasional tool call below the density threshold stays thinking", async () => {
    const exec = sessionExec([
      msgEvent("msg.in", "a", UUID), msgEvent("msg.out", "b", UUID),
      msgEvent("msg.in", "c", UUID), msgEvent("msg.out", "d", UUID),
      msgEvent("msg.in", "e", UUID), msgEvent("msg.out", "f", UUID),
      msgEvent("msg.in", "g", UUID), msgEvent("msg.out", "h", UUID),
      toolEvent(UUID), // 1 tool / 8 messages = 0.125 < 0.25
    ]);
    const s = await findConversationSignal(UUID, BIN, exec, []);
    expect(s?.kind).toBe("thinking");
  });

  test("tool density EXACTLY at the threshold stays thinking (spec is strict >)", async () => {
    const exec = sessionExec([
      msgEvent("msg.in", "a", UUID), msgEvent("msg.out", "b", UUID),
      msgEvent("msg.in", "c", UUID), msgEvent("msg.out", "d", UUID),
      toolEvent(UUID), // 1 tool / 4 messages = 0.25, not > 0.25
    ]);
    const s = await findConversationSignal(UUID, BIN, exec, []);
    expect(s?.kind).toBe("thinking");
  });

  test("a zero-message session with owned tool calls is build, never NaN or a crash", async () => {
    // messages = 0: any tool call beats 0 × density — no division anywhere,
    // and the label must come out defined, not NaN-poisoned.
    const exec = sessionExec([toolEvent(UUID), toolEvent(UUID, "2026-07-14T13:01:00.000Z")]);
    const s = await findConversationSignal(UUID, BIN, exec, []);
    expect(s?.kind).toBe("build");
    expect(s?.finalQuestion).toBeUndefined();
  });

  test("no owned events at all yields no signal, never a guessed label", async () => {
    // Events exist but belong to another session (mention-only guard) —
    // exactly the orchestrator-quoting shape the evidence upgrade rejects.
    const exec = sessionExec([
      msgEvent("msg.in", "quoting this session in passing", "some-other-uuid"),
      editEvent("/repo/src/a.ts", "some-other-uuid"),
    ]);
    expect(await findConversationSignal(UUID, BIN, exec, [])).toBeUndefined();
  });

  test("counts accumulate across grep candidates (tape slices split the dialogue)", async () => {
    const otherSlice = "1111111111111111111111111111111111111111111111111111111111111111";
    const exec = twoStepExec(grepResponse([ENGRAM_SID, otherSlice]), {
      [ENGRAM_SID]: peekResponse([msgEvent("msg.in", "task", UUID)]),
      [otherSlice]: peekResponse([editEvent("/repo/src/a.ts", UUID)]),
    });
    const s = await findConversationSignal(UUID, BIN, exec, []);
    expect(s?.kind).toBe("build"); // the edit lives in the second slice
  });
});

describe("findDialogueFacts — the awaited question", () => {
  test("quotes the last question sentence of the newest owned msg.out", async () => {
    const exec = sessionExec([
      msgEvent("msg.out", "Should I use SQLite? Actually, wait.", UUID, "2026-07-14T13:00:00.000Z"),
      msgEvent(
        "msg.out",
        "I finished the analysis. Do you want the annual plan screen to keep the Maybe Later button?",
        UUID,
        "2026-07-14T13:05:00.000Z",
      ),
    ]);
    const s = await findConversationSignal(UUID, BIN, exec, []);
    expect(s?.finalQuestion?.toString()).toBe(
      "Do you want the annual plan screen to keep the Maybe Later button?",
    );
  });

  test("ordinary punctuation inside the sentence never garbles the quote (filenames, versions)", async () => {
    // A dot NOT followed by whitespace is not a sentence boundary: the old
    // extractor quoted this as "ts or roll back?".
    const exec = sessionExec([
      msgEvent("msg.out", "I diffed both. Keep my_file.ts or roll back to v1.2.3?", UUID),
    ]);
    const s = await findConversationSignal(UUID, BIN, exec, []);
    expect(s?.finalQuestion?.toString()).toBe("Keep my_file.ts or roll back to v1.2.3?");
  });

  test("newer instant wins even when timezone offsets make the raw timestamps sort backwards", async () => {
    // Lexicographically "2026-07-14T20:00:00.000+09:00" > "2026-07-14T13:30:00.000Z",
    // but as an instant it is 11:00Z — the Z-stamped 13:30 message is newer.
    const exec = sessionExec([
      msgEvent("msg.out", "Old ask from the offset slice?", UUID, "2026-07-14T20:00:00.000+09:00"),
      msgEvent("msg.out", "Ship it now?", UUID, "2026-07-14T13:30:00.000Z"),
    ]);
    const s = await findConversationSignal(UUID, BIN, exec, []);
    expect(s?.finalQuestion?.toString()).toBe("Ship it now?");
  });

  test("a final message that asks nothing yields no question — never fabricated", async () => {
    const exec = sessionExec([
      msgEvent("msg.out", "Should I keep going?", UUID, "2026-07-14T13:00:00.000Z"),
      msgEvent("msg.out", "All done. Everything is committed.", UUID, "2026-07-14T13:05:00.000Z"),
    ]);
    const s = await findConversationSignal(UUID, BIN, exec, []);
    expect(s?.finalQuestion).toBeUndefined();
  });

  test("another session's msg.out can never donate the question (mention-only guard)", async () => {
    const exec = sessionExec([
      msgEvent("msg.in", "task", UUID),
      msgEvent("msg.out", "Should we deploy?", "some-other-uuid", "2026-07-14T14:00:00.000Z"),
    ]);
    const s = await findConversationSignal(UUID, BIN, exec, []);
    expect(s?.finalQuestion).toBeUndefined();
  });

  test("a msg.out with a garbage timestamp still counts for classification but never claims to be final", async () => {
    const exec = sessionExec([
      msgEvent("msg.out", "Pick A or B?", UUID, "2026-07-14T13:00:00.000Z"),
      msgEvent("msg.out", "Bogus but later-looking?", UUID, "not a timestamp"),
    ]);
    const s = await findConversationSignal(UUID, BIN, exec, []);
    expect(s?.kind).toBe("thinking"); // both messages counted
    expect(s?.finalQuestion?.toString()).toBe("Pick A or B?");
  });

  test("the question passes the redaction choke point: builtin and user patterns apply", async () => {
    const SECRET = "sk-fixturesecret1234567890abcdef";
    const exec = sessionExec([
      msgEvent("msg.out", `The key ${SECRET} failed — should I rotate hunter2secret too?`, UUID),
    ]);
    const s = await findConversationSignal(UUID, BIN, exec, ["hunter2secret"]);
    expect(s?.finalQuestion).toBeDefined();
    expect(s!.finalQuestion!).not.toContain(SECRET);
    expect(s!.finalQuestion!).not.toContain("hunter2secret");
    expect(s!.finalQuestion!).toContain("[REDACTED]");
  });

  test("the question is structurally inert: angle brackets and newlines cannot survive", async () => {
    const exec = sessionExec([
      msgEvent("msg.out", 'Keep <img src=x onerror=alert(1)>\n## forged heading in the layout?', UUID),
    ]);
    const s = await findConversationSignal(UUID, BIN, exec, []);
    expect(s?.finalQuestion).toBeDefined();
    expect(s!.finalQuestion!).not.toContain("<");
    expect(s!.finalQuestion!).not.toContain(">");
    expect(s!.finalQuestion!).not.toContain("\n");
  });

  test("an overlong question is capped with an ellipsis after sanitization", async () => {
    const long = `${"x".repeat(400)} — should I proceed?`;
    const exec = sessionExec([msgEvent("msg.out", long, UUID)]);
    const s = await findConversationSignal(UUID, BIN, exec, []);
    expect(s?.finalQuestion).toBeDefined();
    expect(s!.finalQuestion!.length).toBeLessThanOrEqual(301); // 300 + ellipsis
    expect(s!.finalQuestion!.endsWith("…")).toBe(true);
  });

  test("the cap never splits a [REDACTED] marker: the cut backs off to before it", async () => {
    const SECRET = "sk-fixturesecret1234567890abcdef";
    // Sanitized shape: 294 x's + " " + "[REDACTED]" (cols 295–304) + " ok?"
    // — the naive 300-char cut lands mid-marker.
    const exec = sessionExec([
      msgEvent("msg.out", `${"x".repeat(294)} ${SECRET} ok?`, UUID),
    ]);
    const s = await findConversationSignal(UUID, BIN, exec, []);
    expect(s?.finalQuestion?.toString()).toBe(`${"x".repeat(294)}…`);
    expect(s!.finalQuestion!).not.toContain(SECRET);
  });

  test("the cap never splits a surrogate pair: a non-BMP char at the boundary survives whole or not at all", async () => {
    // "😀" occupies UTF-16 units 299–300: the naive cut at 300 would keep a
    // lone high surrogate that renders as U+FFFD.
    const exec = sessionExec([
      msgEvent("msg.out", `${"x".repeat(299)}😀 and then some — proceed?`, UUID),
    ]);
    const s = await findConversationSignal(UUID, BIN, exec, []);
    expect(s?.finalQuestion?.toString()).toBe(`${"x".repeat(299)}…`);
    expect(s!.finalQuestion!).not.toContain("\ud83d"); // no lone high surrogate
  });
});

describe("findDialogueFacts — probe discipline", () => {
  test("issues the exact grep and peek argv shapes (widest kind filter)", async () => {
    const calls: string[][] = [];
    const inner = sessionExec([msgEvent("msg.in", "task", UUID)]);
    const exec: Exec = async (argv) => {
      calls.push(argv);
      return inner(argv);
    };
    await findConversationSignal(UUID, BIN, exec, []);
    expect(calls[0]).toEqual([BIN, "grep", UUID, "--limit", "3"]);
    expect(calls[1]).toEqual([BIN, "peek", ENGRAM_SID, "--grep-filter", EVENT_FILTER]);
  });

  test("ONE walk serves both folds: keys and signal come from the same grep+peek calls", async () => {
    const calls: string[][] = [];
    const inner = sessionExec([
      msgEvent("msg.in", "pick up bead asl-1wm", UUID),
      editEvent("/repo/src/a.ts", UUID),
    ]);
    const exec: Exec = async (argv) => {
      calls.push(argv);
      return inner(argv);
    };
    const facts = await findDialogueFacts(UUID, ["asl"], BIN, exec, []);
    expect(facts.keys).toEqual(["asl-1wm"]);
    expect(facts.signal?.kind).toBe("build");
    expect(calls.length).toBe(2); // 1 grep + 1 peek, both outputs
  });

  test("no bead prefixes: the walk still runs for the signal fold, keys stay empty", async () => {
    const calls: string[][] = [];
    const inner = sessionExec([msgEvent("msg.in", "pick up bead asl-1wm", UUID)]);
    const exec: Exec = async (argv) => {
      calls.push(argv);
      return inner(argv);
    };
    const facts = await findDialogueFacts(UUID, [], BIN, exec, []);
    expect(facts.keys).toEqual([]);
    expect(facts.signal?.kind).toBe("thinking");
    expect(calls.length).toBe(2);
  });

  test("rejects hostile or malformed session ids without ever calling exec", async () => {
    for (const hostile of ["--help", "$(rm -rf /)", "", "--------", "-deadbeef0", "a".repeat(65)]) {
      let calls = 0;
      const spy: Exec = async () => {
        calls++;
        return { ok: true, stdout: "", stderr: "" };
      };
      expect(await findConversationSignal(hostile, BIN, spy, [])).toBeUndefined();
      expect(calls).toBe(0);
    }
  });

  test("never throws: failing exec, malformed JSON, throwing exec all yield no signal", async () => {
    expect(await findConversationSignal(UUID, BIN, execFail, [])).toBeUndefined();
    expect(await findConversationSignal(UUID, BIN, execOk("garbage{{"), [])).toBeUndefined();
    const throwing: Exec = async () => {
      throw new Error("boom");
    };
    expect(await findConversationSignal(UUID, BIN, throwing, [])).toBeUndefined();
  });
});

describe("discoverDialogueFacts", () => {
  const enabled = { enabled: true, binaryPath: BIN, beadPrefixes: [] };
  const disabled = { enabled: false, binaryPath: BIN, beadPrefixes: [] };

  test("disabled connector returns an empty map without calling exec", async () => {
    let calls = 0;
    const spy: Exec = async () => {
      calls++;
      return { ok: true, stdout: cliStdout({ error: "no_results" }), stderr: "" };
    };
    const r = await discoverDialogueFacts(
      [{ sessionId: UUID, startedAt: "2026-07-07T12:00:00.000Z" }],
      disabled,
      { redactPatterns: [], exec: spy },
    );
    expect(r.size).toBe(0);
    expect(calls).toBe(0);
  });

  test("probes newest-first, once per session id, and maps only observed sessions", async () => {
    const OTHER = "bbbb0000-0000-4000-8000-00000000000b";
    const grepped: string[] = [];
    const exec: Exec = async (argv) => {
      if (argv[1] === "grep") {
        grepped.push(argv[2]!);
        if (argv[2] === UUID) return { ok: true, stdout: grepResponse([ENGRAM_SID]), stderr: "" };
        return { ok: true, stdout: cliStdout({ error: "no_results" }), stderr: "" };
      }
      return { ok: true, stdout: peekResponse([msgEvent("msg.in", "task", UUID)]), stderr: "" };
    };
    const r = await discoverDialogueFacts(
      [
        { sessionId: UUID, startedAt: "2026-07-07T11:00:00.000Z" },
        { sessionId: OTHER, startedAt: "2026-07-07T12:00:00.000Z" },
        { sessionId: UUID, startedAt: "2026-07-07T13:00:00.000Z" }, // duplicate id: probed once
      ],
      enabled,
      { redactPatterns: [], exec },
    );
    expect(grepped).toEqual([UUID, OTHER]); // duplicate skipped; newest first
    expect(r.get(UUID)?.signal?.kind).toBe("thinking");
    expect(r.has(OTHER)).toBe(false); // unobserved → no entry
  });

  test("never throws even if exec throws (the single fail-soft boundary)", async () => {
    const throwing: Exec = async () => {
      throw new Error("boom");
    };
    const r = await discoverDialogueFacts(
      [{ sessionId: UUID, startedAt: "2026-07-07T12:00:00.000Z" }],
      enabled,
      { redactPatterns: [], exec: throwing },
    );
    expect(r.size).toBe(0);
  });
});
