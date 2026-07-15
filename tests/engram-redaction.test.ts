// Engram redaction contract (asl-a5v): every tape-sourced string passes
// through the sanitizeTapeText choke point at ingestion — where Engram
// subprocess output is parsed — so no render surface (json, markdown, html,
// digest, email) can ever see an unredacted Engram-derived string, and no
// future render path can bypass redaction by forgetting a render-time call.
import { describe, expect, test } from "bun:test";
import { corroborateSessions, sanitizeTapeText, upgradeEvidence } from "../src/connectors/engram";
import type { Exec } from "../src/exec";
import type { AgentReport, RawSession, Report } from "../src/types";
import { renderJson } from "../src/render/json";
import { renderMarkdown } from "../src/render/markdown";
import { renderHtml } from "../src/render/html";
import { renderEmailDigest } from "../src/render/digest";
import { buildMimeMessage } from "../src/email";

// Fixture secret embedded in Engram tape output (a file path an agent might
// genuinely create): matches redact.ts's builtin sk- rule, so surviving any
// surface means the boundary leaked.
const SECRET = "sk-fixturesecret1234567890abcdef";
const SECRET_FILE = `/repo/src/${SECRET}.ts`;

const UUID = "989533ee-ec57-4ac9-b510-9d6cb8b1b969";
const ENGRAM_SID = "cbe8ebd49d60f46dac4ca64c3058ad0617d5c888811025b771d82e94e2faa455";
const BIN = "/path/to/engram";

function cliStdout(json: unknown): string {
  return `config: /Users/gd/.engram/config.yml\ndb: /Users/gd/.engram/index.sqlite\n${JSON.stringify(json)}\n`;
}

function grepResponse(sessionIds: string[]): string {
  return cliStdout({
    returned: sessionIds.length,
    sessions: sessionIds.map((session_id, i) => ({
      session_id,
      confidence: 325.0 - i,
      files_touched: ["/whatever/file.ts"],
      timestamp: "2026-07-14T13:39:18.481Z",
    })),
  });
}

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

// Mocked Engram subprocess whose tape output leaks the fixture secret in an
// edited-file path — the exact shape future dialogue quoting will amplify.
const leakyExec = twoStepExec(grepResponse([ENGRAM_SID]), {
  [ENGRAM_SID]: peekResponse([editEvent(SECRET_FILE, UUID), editEvent("/repo/src/ok.ts", UUID)]),
});

function rawSession(sessionId: string, startedAt: string): RawSession {
  return {
    platform: "claude-code", sessionId, cwd: "/w",
    startedAt, lastEventAt: startedAt,
    events: [], filesTouched: [], errors: [],
  };
}

describe("sanitizeTapeText (the choke point)", () => {
  test("composes redact.ts rules: builtin secret shapes come back as [REDACTED]", () => {
    const out = sanitizeTapeText(`edited ${SECRET_FILE} and /repo/src/ok.ts`);
    expect(out).not.toContain(SECRET);
    expect(out).toContain("[REDACTED]");
    expect(out).toContain("/repo/src/ok.ts");
  });

  test("applies user extraPatterns on top of the builtin rules", () => {
    const out = sanitizeTapeText("path /repo/hunter2secret/x.ts", ["hunter2secret"]);
    expect(out).not.toContain("hunter2secret");
    expect(out).toContain("[REDACTED]");
  });

  test("keeps the existing citation hardening: control chars, newlines, angle brackets stripped", () => {
    const out = sanitizeTapeText("/repo/<img src=x>\n## heading\t/thing.ts");
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
    expect(out).not.toContain("\n");
    expect(out).not.toContain("\t");
    expect(out).toContain("img src=x");
  });

  test("a control-char-split secret cannot reassemble past redaction (strip glues, post-strip redact catches)", () => {
    // The pre-strip redact pass sees two too-short fragments; the strip then
    // glues them into a live key, so a second redact pass must run after it.
    const split = "sk-fixture\x00secret1234567890abcdef";
    const out = sanitizeTapeText(`key ${split} end`, []);
    expect(out).not.toContain(SECRET);
    expect(out).toContain("[REDACTED]");
  });

  test("inverse glue evasion: stripping must not un-match a boundary-dependent builtin rule (AWS)", () => {
    // Pre-strip, "AKIA…F\x00X" matches \bAKIA[0-9A-Z]{16}\b (the \x00 is a
    // word boundary). Strip-first would glue the X on and produce a 17-char
    // run the rule no longer matches — so redaction must ALSO run pre-strip.
    const out = sanitizeTapeText("key AKIA1234567890ABCDEF\x00X end", []);
    expect(out).not.toContain("AKIA1234567890ABCDEF");
    expect(out).toContain("[REDACTED]");
  });

  test("inverse glue evasion: boundary-dependent user extraPattern still matches", () => {
    const out = sanitizeTapeText("pw hunter2\x00suffix end", ["hunter2\\b"]);
    expect(out).not.toContain("hunter2");
    expect(out).toContain("[REDACTED]");
  });

  test("zero-width characters cannot split a secret past redaction (ZWSP)", () => {
    // U+200B is invisible in every renderer but breaks the sk- rule's char
    // class; a downstream copy-paste reconstructs the live key. The strip
    // set must cover Unicode format chars, and the post-strip redact pass
    // must catch the reassembled key.
    const out = sanitizeTapeText("key sk-fixture\u200Bsecret1234567890abcdef end", []);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain("\u200B");
    expect(out).toContain("[REDACTED]");
  });

  test("zero-width joiner cannot split a builtin AWS key past redaction", () => {
    const out = sanitizeTapeText("key AKIA1234\u200D567890ABCDEF end", []);
    expect(out).not.toContain("AKIA1234567890ABCDEF");
    expect(out).toContain("[REDACTED]");
  });

  test("bidi controls, word joiner, and BOM are stripped from the citation text", () => {
    const out = sanitizeTapeText("/repo/\u202Esrc\u2066/x\u2060.ts\uFEFF done", []);
    for (const ch of ["\u202E", "\u2066", "\u2060", "\uFEFF"]) expect(out).not.toContain(ch);
    expect(out).toContain("done");
  });
});

describe("boundary guard: engram parsing never returns raw tape text", () => {
  test("upgradeEvidence's entire result carries no unredacted tape secret", () => {
    const r = upgradeEvidence(UUID, BIN, leakyExec);
    expect(r.matched).toBe(true);
    // every string field of the result, not just citation
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(r.citation).toContain("[REDACTED]");
    expect(r.citation).toContain("/repo/src/ok.ts");
  });

  test("upgradeEvidence applies user extraPatterns at the boundary", () => {
    const exec = twoStepExec(grepResponse([ENGRAM_SID]), {
      [ENGRAM_SID]: peekResponse([editEvent("/repo/customsecretvalue/a.ts", UUID)]),
    });
    const r = upgradeEvidence(UUID, BIN, exec, ["customsecretvalue"]);
    expect(r.matched).toBe(true);
    expect(r.citation).not.toContain("customsecretvalue");
    expect(r.citation).toContain("[REDACTED]");
  });

  test("corroborateSessions threads extraPatterns through to the boundary", () => {
    const exec = twoStepExec(grepResponse([ENGRAM_SID]), {
      [ENGRAM_SID]: peekResponse([editEvent("/repo/customsecretvalue/a.ts", UUID)]),
    });
    const r = corroborateSessions(
      [rawSession(UUID, "2026-07-07T12:00:00.000Z")],
      { enabled: true, binaryPath: BIN },
      exec,
      ["customsecretvalue"],
    );
    expect(r.matched).toBe(true);
    expect(r.citation).not.toContain("customsecretvalue");
    expect(r.citation).toContain("[REDACTED]");
  });
});

// End-to-end: a secret in mocked Engram subprocess output must not survive
// into any of the five render surfaces. The citation is obtained through the
// real connector path (mocked Exec seam), then rendered through each surface.
describe("redaction contract across all render surfaces", () => {
  const upgrade = corroborateSessions(
    [rawSession(UUID, "2026-07-07T12:00:00.000Z")],
    { enabled: true, binaryPath: BIN },
    leakyExec,
  );

  function agentWithCitation(): AgentReport {
    return {
      profileId: "claude-code:/w", displayName: "w (claude-code)", platform: "claude-code", workdir: "/w",
      status: "completed", severity: "info", evidence: "partially_proven",
      evidenceCitation: upgrade.citation,
      facts: {
        titles: ["Fix login bug"], filesTouched: ["/w/src/login.ts"], errors: [],
        commits: [], sessionCount: 1,
        firstActivity: "2026-07-07T09:00:00.000Z", lastActivity: "2026-07-07T09:30:00.000Z",
      },
      narrative: {
        workedOn: "Fixed login.", completed: "Login fix committed.", inProgress: "Nothing.",
        blocked: "None.", recommendation: "Review the commit.",
        standup: "I fixed the login bug. Nothing is blocking me.",
      },
      narrativeSource: "template",
      commits: [],
    };
  }

  const report: Report = {
    schemaVersion: 1,
    generatedAt: "2026-07-08T07:00:00.000Z",
    windowStart: "2026-07-07T07:00:00.000Z",
    windowEnd: "2026-07-08T07:00:00.000Z",
    exceptions: [],
    agents: [agentWithCitation()],
  };

  test("the connector really matched and cited (fixture sanity)", () => {
    expect(upgrade.matched).toBe(true);
    expect(upgrade.citation).toBeDefined();
  });

  test("json surface: secret absent, [REDACTED] present", () => {
    const out = renderJson(report);
    expect(out).not.toContain(SECRET);
    expect(out).toContain("[REDACTED]");
  });

  test("markdown surface: secret absent, [REDACTED] present", () => {
    const out = renderMarkdown(report);
    expect(out).not.toContain(SECRET);
    // markdown escapes literal brackets: the marker renders as \[REDACTED\]
    expect(out).toMatch(/\\?\[REDACTED\\?\]/);
  });

  test("html surface: secret absent, [REDACTED] present", () => {
    const out = renderHtml(report);
    expect(out).not.toContain(SECRET);
    expect(out).toContain("[REDACTED]");
  });

  test("digest surface: secret absent", () => {
    // The digest does not render citations today, so no [REDACTED] marker is
    // expected — the contract here is pure absence, and it must keep holding
    // if the digest ever grows a citation line.
    const out = renderEmailDigest(report);
    expect(out).not.toContain(SECRET);
  });

  test("email surface: secret absent from the full MIME message, marker survives base64 round-trip", () => {
    const html = renderHtml(report);
    const digest = renderEmailDigest(report);
    const mime = buildMimeMessage({
      from: "a@example.com", to: "b@example.com", subject: "ASL - 2026-07-08",
      text: renderMarkdown(report), html: digest,
      date: new Date("2026-07-08T07:00:00.000Z"),
      messageId: "m.asl@smtp.example.com", boundary: "=_asl-b",
      attachment: { data: { filename: "2026-07-08.html", content: html }, boundary: "=_asl-mix-b" },
    });
    // quoted-printable soft breaks may split any literal; normalize first
    const qpJoined = mime.replaceAll("=\r\n", "");
    expect(qpJoined).not.toContain(SECRET);
    // decode the base64 attachment body and check the real bytes
    const b64 = mime
      .split('Content-Disposition: attachment; filename="2026-07-08.html"\r\n\r\n')[1]!
      .split("\r\n--=_asl-mix-b--")[0]!
      .replaceAll("\r\n", "");
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    expect(decoded).not.toContain(SECRET);
    expect(decoded).toContain("[REDACTED]");
  });
});
