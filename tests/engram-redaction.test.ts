// Engram redaction contract (asl-a5v): every tape-sourced string passes
// through the sanitizeTapeText choke point at ingestion — where Engram
// subprocess output is parsed — so no render surface (json, markdown, html,
// digest, email) can ever see an unredacted Engram-derived string, and no
// future render path can bypass redaction by forgetting a render-time call.
import { describe, expect, test } from "bun:test";
import { corroborateSessions, sanitizeTapeText, upgradeEvidence } from "../src/connectors/engram";
import type { AgentReport, Report } from "../src/types";
import { renderJson } from "../src/render/json";
import { renderMarkdown } from "../src/render/markdown";
import { renderHtml } from "../src/render/html";
import { renderEmailDigest } from "../src/render/digest";
import { buildMimeMessage } from "../src/email";
import {
  BIN, ENGRAM_SID, UUID,
  editEvent, grepResponse, peekResponse, rawSession, twoStepExec,
} from "./helpers/engram-fixtures";

// Fixture secret embedded in Engram tape output (a file path an agent might
// genuinely create): matches redact.ts's builtin sk- rule, so surviving any
// surface means the boundary leaked.
const SECRET = "sk-fixturesecret1234567890abcdef";
const SECRET_FILE = `/repo/src/${SECRET}.ts`;

// Mocked Engram subprocess whose tape output leaks the fixture secret in an
// edited-file path — the exact shape future dialogue quoting will amplify.
const leakyExec = twoStepExec(grepResponse([ENGRAM_SID]), {
  [ENGRAM_SID]: peekResponse([editEvent(SECRET_FILE, UUID), editEvent("/repo/src/ok.ts", UUID)]),
});

describe("sanitizeTapeText (the choke point)", () => {
  test("composes redact.ts rules: builtin secret shapes come back as [REDACTED]", async () => {
    const out = sanitizeTapeText(`edited ${SECRET_FILE} and /repo/src/ok.ts`, []);
    expect(out).not.toContain(SECRET);
    expect(out).toContain("[REDACTED]");
    expect(out).toContain("/repo/src/ok.ts");
  });

  test("applies user extraPatterns on top of the builtin rules", async () => {
    const out = sanitizeTapeText("path /repo/hunter2secret/x.ts", ["hunter2secret"]);
    expect(out).not.toContain("hunter2secret");
    expect(out).toContain("[REDACTED]");
  });

  test("keeps the existing citation hardening: control chars, newlines, angle brackets stripped", async () => {
    const out = sanitizeTapeText("/repo/<img src=x>\n## heading\t/thing.ts", []);
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
    expect(out).not.toContain("\n");
    expect(out).not.toContain("\t");
    expect(out).toContain("img src=x");
  });

  test("a control-char-split secret cannot reassemble past redaction (strip glues, post-strip redact catches)", async () => {
    // The pre-strip redact pass sees two too-short fragments; the strip then
    // glues them into a live key, so a second redact pass must run after it.
    const split = "sk-fixture\x00secret1234567890abcdef";
    const out = sanitizeTapeText(`key ${split} end`, []);
    expect(out).not.toContain(SECRET);
    expect(out).toContain("[REDACTED]");
  });

  test("inverse glue evasion: stripping must not un-match a boundary-dependent builtin rule (AWS)", async () => {
    // Pre-strip, "AKIA…F\x00X" matches \bAKIA[0-9A-Z]{16}\b (the \x00 is a
    // word boundary). Strip-first would glue the X on and produce a 17-char
    // run the rule no longer matches — so redaction must ALSO run pre-strip.
    const out = sanitizeTapeText("key AKIA1234567890ABCDEF\x00X end", []);
    expect(out).not.toContain("AKIA1234567890ABCDEF");
    expect(out).toContain("[REDACTED]");
  });

  test("inverse glue evasion: boundary-dependent user extraPattern still matches", async () => {
    const out = sanitizeTapeText("pw hunter2\x00suffix end", ["hunter2\\b"]);
    expect(out).not.toContain("hunter2");
    expect(out).toContain("[REDACTED]");
  });

  test("zero-width characters cannot split a secret past redaction (ZWSP)", async () => {
    // U+200B is invisible in every renderer but breaks the sk- rule's char
    // class; a downstream copy-paste reconstructs the live key. The strip
    // set must cover Unicode format chars, and the post-strip redact pass
    // must catch the reassembled key.
    const out = sanitizeTapeText("key sk-fixture\u200Bsecret1234567890abcdef end", []);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain("\u200B");
    expect(out).toContain("[REDACTED]");
  });

  test("zero-width joiner cannot split a builtin AWS key past redaction", async () => {
    const out = sanitizeTapeText("key AKIA1234\u200D567890ABCDEF end", []);
    expect(out).not.toContain("AKIA1234567890ABCDEF");
    expect(out).toContain("[REDACTED]");
  });

  test("combining grapheme joiner (U+034F, Mn not Cf) cannot invisibly split a builtin secret", async () => {
    // CGJ is default-ignorable (renders as nothing) but is a nonspacing mark,
    // not a format char — a \p{Cf}-only strip leaves it in place, the sk-
    // rule's char class never matches across it, and the rendered/copied text
    // visually reconstructs the live key.
    const out = sanitizeTapeText("key sk-fixture\u034Fsecret1234567890abcdef end", []);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain("\u034F");
    expect(out).toContain("[REDACTED]");
  });

  test("variation selector (U+FE00, Mn not Cf) cannot invisibly split a builtin secret", async () => {
    const out = sanitizeTapeText("key sk-fixture\uFE00secret1234567890abcdef end", []);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain("\uFE00");
    expect(out).toContain("[REDACTED]");
  });

  test("plane-14 variation selector (U+E0100) cannot invisibly split a builtin secret", async () => {
    const out = sanitizeTapeText("key sk-fixture\u{E0100}secret1234567890abcdef end", []);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain("\u{E0100}");
    expect(out).toContain("[REDACTED]");
  });

  test("legitimate NFD combining marks in file paths survive intact (no blanket Mn strip)", async () => {
    // The default-ignorable strip must NOT widen to all of \p{Mn}: macOS
    // (HFS+/APFS) stores filenames in NFD, so "café.ts" arrives as
    // "café.ts" and the combining acute is load-bearing content.
    const nfd = "/repo/cafe\u0301.ts";
    // .toString() widens the SanitizedTapeText brand so toBe accepts the
    // plain-string expected value.
    expect(sanitizeTapeText(nfd, []).toString()).toBe(nfd);
  });

  test("bidi controls, word joiner, and BOM are stripped from the citation text", async () => {
    const out = sanitizeTapeText("/repo/\u202Esrc\u2066/x\u2060.ts\uFEFF done", []);
    for (const ch of ["\u202E", "\u2066", "\u2060", "\uFEFF"]) expect(out).not.toContain(ch);
    expect(out).toContain("done");
  });

  test("pathological extraPatterns that match the marker mangle it cosmetically but never leak a secret", async () => {
    // Known accepted limitation (see sanitizeTapeText's comment): the second
    // redact pass re-matches the first pass's [REDACTED] markers when a user
    // pattern matches the marker text itself, producing noise like
    // [[[REDACTED]]]. This pins the security invariant that survives it: the
    // SECRET is gone in every pathological case.
    for (const patterns of [["REDACTED"], ["\\]"], ["\\["], ["\\[REDACTED\\]"]]) {
      const out = sanitizeTapeText(`key ${SECRET} end`, patterns);
      expect(out).not.toContain(SECRET);
    }
  });
});

describe("boundary guard: engram parsing never returns raw tape text", () => {
  test("upgradeEvidence's entire result carries no unredacted tape secret", async () => {
    const r = await upgradeEvidence(UUID, BIN, leakyExec, []);
    expect(r.matched).toBe(true);
    // every string field of the result, not just citation
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(r.citation).toContain("[REDACTED]");
    expect(r.citation).toContain("/repo/src/ok.ts");
  });

  test("upgradeEvidence applies user extraPatterns at the boundary", async () => {
    const exec = twoStepExec(grepResponse([ENGRAM_SID]), {
      [ENGRAM_SID]: peekResponse([editEvent("/repo/customsecretvalue/a.ts", UUID)]),
    });
    const r = await upgradeEvidence(UUID, BIN, exec, ["customsecretvalue"]);
    expect(r.matched).toBe(true);
    expect(r.citation).not.toContain("customsecretvalue");
    expect(r.citation).toContain("[REDACTED]");
  });

  test("corroborateSessions threads extraPatterns through to the boundary", async () => {
    const exec = twoStepExec(grepResponse([ENGRAM_SID]), {
      [ENGRAM_SID]: peekResponse([editEvent("/repo/customsecretvalue/a.ts", UUID)]),
    });
    const r = await corroborateSessions(
      [rawSession(UUID, "2026-07-07T12:00:00.000Z")],
      { enabled: true, binaryPath: BIN, beadPrefixes: [] },
      { redactPatterns: ["customsecretvalue"], exec },
    );
    expect(r.matched).toBe(true);
    expect(r.citation).not.toContain("customsecretvalue");
    expect(r.citation).toContain("[REDACTED]");
  });
});

// End-to-end: a secret in mocked Engram subprocess output must not survive
// into any of the five render surfaces. The citation is obtained through the
// real connector path (mocked Exec seam), then rendered through each surface.
// Top-level await: the connector is async now, and the describe body (which
// cannot be) builds its fixture report from this result.
const upgrade = await corroborateSessions(
  [rawSession(UUID, "2026-07-07T12:00:00.000Z")],
  { enabled: true, binaryPath: BIN, beadPrefixes: [] },
  { redactPatterns: [], exec: leakyExec },
);

describe("redaction contract across all render surfaces", () => {
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

  test("the connector really matched and cited (fixture sanity)", async () => {
    expect(upgrade.matched).toBe(true);
    expect(upgrade.citation).toBeDefined();
  });

  test("json surface: secret absent, [REDACTED] present", async () => {
    const out = renderJson(report);
    expect(out).not.toContain(SECRET);
    expect(out).toContain("[REDACTED]");
  });

  test("markdown surface: secret absent, [REDACTED] present", async () => {
    const out = renderMarkdown(report);
    expect(out).not.toContain(SECRET);
    // markdown escapes literal brackets: the marker renders as \[REDACTED\]
    expect(out).toMatch(/\\?\[REDACTED\\?\]/);
  });

  test("html surface: secret absent, [REDACTED] present", async () => {
    const out = renderHtml(report);
    expect(out).not.toContain(SECRET);
    expect(out).toContain("[REDACTED]");
  });

  test("digest carve-out: an exception's sanitized awaitingQuestion renders — marker present, secret absent", async () => {
    // PRD §13 carve-out (decided 2026-07-17, asl-94g): the ONLY transcript
    // text in the digest is each exception row's awaiting-question line. It
    // reaches the report exclusively through sanitizeTapeText, so what the
    // digest must pin is that the SANITIZED question is rendered while the
    // raw secret never survives.
    const question = sanitizeTapeText(
      `Should I revoke ${SECRET} now or after the release?`, []);
    const waiting = { ...agentWithCitation(), status: "needs_human" as const, severity: "warning" as const, awaitingQuestion: question };
    const withQuestion: Report = {
      ...report,
      agents: [waiting],
      exceptions: [waiting],
    };
    const out = renderEmailDigest(withQuestion);
    expect(out).toContain("Waiting on: “Should I revoke [REDACTED] now or after the release?”");
    expect(out).not.toContain(SECRET);
  });

  test("digest surface renders no citation content at all", async () => {
    // The digest never renders evidenceCitation, so a secret-absence check
    // alone is vacuous — it would pass for an UNREDACTED citation too. The
    // honest invariant to pin is that the citation string as a whole never
    // reaches digest output. If the digest ever starts rendering citations,
    // this test must be replaced with a marker-presence test like the other
    // surfaces (secret absent AND [REDACTED] present).
    const out = renderEmailDigest(report);
    expect(upgrade.citation).toBeDefined();
    // Assert per distinctive component, not just the whole string — a digest
    // that started rendering any PART of the citation (session id, a file
    // path, the marker, the prefix) must fail here, not slip past a
    // whole-string check.
    expect(out).not.toContain(upgrade.citation!);
    expect(out).not.toContain(ENGRAM_SID);
    expect(out).not.toContain("engram session");
    expect(out).not.toContain("/repo/src/ok.ts");
    expect(out).not.toContain("[REDACTED]");
    expect(out).not.toContain(SECRET);
  });

  test("email surface: secret absent from the full MIME message, marker survives base64 round-trip", async () => {
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
