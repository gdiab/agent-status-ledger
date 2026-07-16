// Shared Engram CLI fixtures for tests/engram.test.ts and
// tests/engram-redaction.test.ts: mocked subprocess output in the real
// CLI's shape (two prefix lines, then JSON), tape-event builders, and the
// grep/peek-routing Exec fake.
import type { Exec } from "../../src/exec";
import type { RawSession } from "../../src/types";

// A harness session UUID, as found in RawSession.sessionId.
export const UUID = "989533ee-ec57-4ac9-b510-9d6cb8b1b969";
export const ENGRAM_SID = "cbe8ebd49d60f46dac4ca64c3058ad0617d5c888811025b771d82e94e2faa455";
export const BIN = "/path/to/engram";

export function cliStdout(json: unknown): string {
  // real CLI output shape: two prefix lines, then the JSON on its own line
  return `config: /Users/gd/.engram/config.yml\ndb: /Users/gd/.engram/index.sqlite\n${JSON.stringify(json)}\n`;
}

// `total` is grep's index-wide match count; it exceeds sessions.length when
// --limit (or the CLI's default cap) hid candidates — the truncation signal.
export function grepResponse(sessionIds: string[], total = sessionIds.length): string {
  return cliStdout({
    total,
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

// The dispatch marker as it appears in a RAW tape line: tape events are JSON
// objects, so the quotes inside the event's content string are escaped. The
// lineage probe greps and peek-filters this literal.
export function markerQuery(uuid: string): string {
  return `<engram-src id=\\"${uuid}\\"/>`;
}

// peek returns raw tape event JSON, one event per content line, in
// session.content[].text — and --grep-filter over-matches (context lines of
// other kinds come back too), so realistic fixtures mix event kinds.
export function peekResponse(events: unknown[]): string {
  return cliStdout({
    session: { content: events.map((ev, i) => ({ line: i + 1, text: JSON.stringify(ev) })) },
  });
}

export function editEvent(file: string, sourceSessionId: string): unknown {
  return {
    file,
    k: "code.edit",
    range: [1, 10],
    range_basis: "line",
    source: { harness: "claude-code", session_id: sourceSessionId },
    t: "2026-07-14T13:39:18.481Z",
  };
}

// Routes by subcommand: argv[1] is "grep" or "peek".
export function twoStepExec(grepStdout: string, peekStdoutBySid: Record<string, string>): Exec {
  return async (argv) => {
    if (argv[1] === "grep") return { ok: true, stdout: grepStdout, stderr: "" };
    if (argv[1] === "peek") {
      const sid = argv[2]!;
      const stdout = peekStdoutBySid[sid] ?? cliStdout({ error: "session_not_found", session_id: sid });
      return { ok: true, stdout, stderr: "" };
    }
    return { ok: false, stdout: "", stderr: `unexpected subcommand ${argv[1]}` };
  };
}

export function rawSession(sessionId: string, startedAt: string): RawSession {
  return {
    platform: "claude-code", sessionId, cwd: "/w",
    startedAt, lastEventAt: startedAt,
    events: [], filesTouched: [], errors: [],
  };
}
