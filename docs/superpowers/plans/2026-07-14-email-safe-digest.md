# Email-Safe Digest (asl-3de) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the emailed HTML body with a compact, inline-styled digest that survives Gmail's markup stripping, and move the existing interactive report to an email attachment.

**Architecture:** Add a new renderer (`src/render/digest.ts`) that produces a phone-friendly HTML fragment — rollup line, exceptions list, one row per agent with a lead sentence — using only inline styles, tables, and fixed hex colors (no `<details>`, no CSS grid, no `light-dark()`). Extend `src/email.ts`'s MIME builder to optionally wrap the existing `multipart/alternative` body in a `multipart/mixed` envelope carrying a base64 attachment. Wire `src/cli.ts` to send the digest as the body and the current `renderHtml()` output as the attachment (filename `${day}.html`).

**Tech Stack:** Bun, TypeScript, `bun:sqlite`-free (no DB involved here), `bun test`.

## Global Constraints

- Bug fix bead asl-3de is P3, owner George Diab — claimed, in progress.
- No `<details>`/`<summary>`, no CSS `grid`, no `light-dark()` anywhere in the new digest HTML — these are exactly what Gmail strips/flattens (live-verified 2026-07-14).
- All digest styling is inline (`style="..."` attributes) — no `<style>` block.
- Existing `buildMimeMessage` output with no attachment must remain byte-identical to today's golden test (`tests/email.test.ts` "assembles a deterministic multipart/alternative message") — this is a strict regression guard, not just a nice-to-have.
- `sendReportEmail` must keep its never-throws contract (see its existing try/catch — do not weaken it).
- Reuse existing formatters instead of hand-rolling: `rollupLine`/`statusSummary` (`src/render/rollup.ts`) for the rollup line, `EXCEPTION_STATUSES`/`report.exceptions` (already filtered) for exceptions — never re-derive these.
- `esc()` (HTML-escaping) must be applied to every piece of report-derived text in the digest (`displayName`, `status`, `narrative.recommendation`, `narrative.standup`) — same XSS-safety bar as `renderHtml`.

---

### Task 1: `renderEmailDigest` — the email-safe digest renderer

**Files:**
- Modify: `src/render/html.ts:7-9` (export `esc`), `src/render/html.ts:13` (export `SEVERITY_COLOR`)
- Create: `src/render/digest.ts`
- Test: `tests/digest.test.ts`

**Interfaces:**
- Consumes: `Report`, `AgentReport` (`src/types.ts`); `rollupLine(report: Report): string` (`src/render/rollup.ts:45`); `esc(s: string): string` and `SEVERITY_COLOR: Record<Severity, string>` (now exported from `src/render/html.ts`).
- Produces: `renderEmailDigest(report: Report): string` and `leadSentence(standup: string): string` (exported for direct unit testing) — both consumed by Task 4 (CLI wiring).

- [ ] **Step 1: Export `esc` and `SEVERITY_COLOR` from `src/render/html.ts`**

In `src/render/html.ts`, change:
```ts
function esc(s: string): string {
```
to:
```ts
export function esc(s: string): string {
```
and change:
```ts
const SEVERITY_COLOR: Record<Severity, string> = { urgent: "#c0392b", warning: "#8a6d00", info: "#2d7a46" };
```
to:
```ts
export const SEVERITY_COLOR: Record<Severity, string> = { urgent: "#c0392b", warning: "#8a6d00", info: "#2d7a46" };
```
No other lines change — this is a pure export addition, existing behavior is untouched.

- [ ] **Step 2: Run the existing render suite to confirm the export change is a no-op**

Run: `bun test tests/render.test.ts`
Expected: all tests PASS (unchanged — this step only adds visibility, no logic changed).

- [ ] **Step 3: Write the failing tests for `leadSentence`**

Create `tests/digest.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import type { AgentReport, Report } from "../src/types";
import { leadSentence, renderEmailDigest } from "../src/render/digest";

describe("leadSentence", () => {
  test("returns the first sentence of a multi-sentence standup", () => {
    expect(leadSentence("I fixed the login bug and committed the fix. Nothing is blocking me.")).toBe(
      "I fixed the login bug and committed the fix.",
    );
  });

  test("stops at ! or ? as well as .", () => {
    expect(leadSentence("I shipped it! Onward.")).toBe("I shipped it!");
    expect(leadSentence("Am I blocked? Not anymore.")).toBe("Am I blocked?");
  });

  test("returns the whole string unchanged when there is no terminal punctuation", () => {
    expect(leadSentence("I am mid-task with no period")).toBe("I am mid-task with no period");
  });

  test("a single-sentence standup returns itself", () => {
    expect(leadSentence("I am done.")).toBe("I am done.");
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `bun test tests/digest.test.ts`
Expected: FAIL — `Cannot find module '../src/render/digest'` (the file doesn't exist yet).

- [ ] **Step 5: Create `src/render/digest.ts` with `leadSentence` and a minimal `renderEmailDigest`**

```ts
import type { AgentReport, Report } from "../types";
import { rollupLine } from "./rollup";
import { esc, SEVERITY_COLOR } from "./html";

// First sentence of a standup narrative (standup always opens with "I " —
// see src/narrative.ts's Narrative.standup doc). The digest has room for a
// headline, not the full 2-4 sentence paragraph; a multi-sentence standup
// reads fine cut at its first full stop, question, or exclamation.
export function leadSentence(standup: string): string {
  const m = standup.match(/^(.*?[.!?])(\s|$)/);
  return m ? m[1]! : standup;
}

function exceptionsSection(report: Report): string {
  const items = report.exceptions.length
    ? report.exceptions
        .map(
          (a) =>
            `<li style="margin:0 0 .4rem;"><strong>${esc(a.displayName)}</strong> — ${esc(a.status)}: ${esc(a.narrative.recommendation)}</li>`,
        )
        .join("")
    : `<li style="margin:0;">No exceptions — nothing needs you.</li>`;
  return `<div style="border:1px solid #c0392b55; border-radius:8px; padding:.75rem 1rem; margin:0 0 1rem;">
  <h2 style="font-size:1rem; margin:0 0 .5rem;">Exceptions</h2>
  <ul style="margin:0; padding-left:1.1rem;">${items}</ul>
</div>`;
}

function agentRow(a: AgentReport): string {
  const commits = a.commits.filter((c) => c.attributed).length;
  const files = a.facts.filesTouched.length;
  return `<tr>
  <td style="padding:.6rem 0; border-top:3px solid ${SEVERITY_COLOR[a.severity]}; border-bottom:1px solid #8884;">
    <div style="font-weight:600;">${esc(a.displayName)} <span style="font-weight:400; opacity:.7;">— ${esc(a.status)}</span></div>
    <div style="font-size:.85rem; opacity:.7; margin:.15rem 0;">${commits} commit${commits === 1 ? "" : "s"}, ${files} file${files === 1 ? "" : "s"} touched</div>
    <div style="font-size:.9rem; margin-top:.2rem;">${esc(leadSentence(a.narrative.standup))}</div>
  </td>
</tr>`;
}

// Phone-friendly digest: rollup line, exceptions with one-line context, one
// row per agent. Inline styles only, no <details>, no CSS grid, no
// light-dark() — the interactive report (src/render/html.ts) is attached
// separately for anyone who wants the full view.
export function renderEmailDigest(report: Report): string {
  const day = report.windowEnd.slice(0, 10);
  const rows = report.agents.length
    ? `<table role="presentation" style="width:100%; border-collapse:collapse; margin:0 0 1rem;">${report.agents.map(agentRow).join("")}</table>`
    : `<p style="opacity:.7;">No agent activity in this window.</p>`;
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Agent Standup — ${esc(day)}</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width:40rem; margin:0 auto; padding:1rem; color:#1a1a1a; line-height:1.4;">
<h1 style="font-size:1.2rem; margin:0 0 .3rem;">Agent Standup — ${esc(day)}</h1>
<p style="margin:0 0 1rem; font-size:.9rem; opacity:.75;">${esc(rollupLine(report))}</p>
${exceptionsSection(report)}
${rows}
<p style="font-size:.8rem; opacity:.6; margin-top:1rem;">Full interactive report attached.</p>
</body>
</html>
`;
}
```

- [ ] **Step 6: Run the test to verify `leadSentence` passes**

Run: `bun test tests/digest.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add src/render/html.ts src/render/digest.ts tests/digest.test.ts
git commit -m "feat: add renderEmailDigest and export esc/SEVERITY_COLOR (asl-3de)"
```

---

### Task 2: `renderEmailDigest` content tests — rollup, exceptions, rows, safety

**Files:**
- Modify: `tests/digest.test.ts`
- Modify (if any bug surfaces): `src/render/digest.ts`

**Interfaces:**
- Consumes: `renderEmailDigest` and `leadSentence` from Task 1.
- Produces: no new interfaces — this task only adds test coverage and fixes anything the tests catch.

- [ ] **Step 1: Write the failing content tests**

Append to `tests/digest.test.ts`:
```ts
function agent(over: Partial<AgentReport>): AgentReport {
  return {
    profileId: "claude-code:/w", displayName: "w (claude-code)", platform: "claude-code", workdir: "/w",
    status: "completed", severity: "info", evidence: "proven",
    facts: {
      titles: ["Fix login bug"], filesTouched: ["/w/src/login.ts"], errors: [],
      commits: ["abc1234 fix login redirect"], sessionCount: 1,
      firstActivity: "2026-07-07T09:00:00.000Z", lastActivity: "2026-07-07T09:30:00.000Z",
    },
    narrative: {
      workedOn: "Fixed login.", completed: "Login fix committed.", inProgress: "Nothing.", blocked: "None.",
      recommendation: "Review the commit.",
      standup: "I fixed the login bug and committed the fix. Nothing is blocking me.",
    },
    narrativeSource: "template",
    commits: [{ sha: "abc1234abcdefghijklmnopqrstuvwxyz123456", authorDate: "2026-07-07T09:20:00.000Z", subject: "fix login redirect", attributed: true }],
    ...over,
  };
}

const blocked = agent({
  profileId: "codex:/infra", displayName: "infra (codex)", status: "needs_human", severity: "warning",
  evidence: "claimed_only",
  narrative: {
    workedOn: "Investigated the deploy failure.", completed: "Nothing.", inProgress: "Root-causing the timeout.",
    blocked: "Waiting on a decision about the retry policy.", recommendation: "Needs a human call on retry semantics.",
    standup: "I'm blocked on the retry policy decision. Someone needs to weigh in.",
  },
});

const report: Report = {
  schemaVersion: 1,
  generatedAt: "2026-07-08T07:00:00.000Z",
  windowStart: "2026-07-07T07:00:00.000Z",
  windowEnd: "2026-07-08T07:00:00.000Z",
  exceptions: [blocked],
  agents: [agent({}), blocked],
};

describe("renderEmailDigest", () => {
  test("includes the shared rollupLine rollup sentence", () => {
    const html = renderEmailDigest(report);
    expect(html).toContain("2 agents: 1 needs_human — 1 commit, 1 file touched");
  });

  test("one row per agent with name, status, counts, and lead sentence", () => {
    const html = renderEmailDigest(report);
    expect(html).toContain("w (claude-code)");
    expect(html).toContain("— completed");
    expect(html).toContain("1 commit, 1 file touched");
    expect(html).toContain("I fixed the login bug and committed the fix.");
    expect(html).toContain("infra (codex)");
    expect(html).toContain("— needs_human");
    // esc() does not escape apostrophes (see src/render/html.ts's esc()), so
    // this appears verbatim.
    expect(html).toContain("I'm blocked on the retry policy decision.");
  });

  test("exceptions section lists one-line context for exception agents only", () => {
    const html = renderEmailDigest(report);
    expect(html).toContain("Needs a human call on retry semantics.");
    expect(html).not.toContain("Review the commit."); // non-exception agent's recommendation stays out of Exceptions
  });

  test("no exceptions renders the reassurance line", () => {
    const html = renderEmailDigest({ ...report, exceptions: [] });
    expect(html).toContain("No exceptions — nothing needs you.");
  });

  test("no agent activity renders a message instead of an empty table", () => {
    const html = renderEmailDigest({ ...report, agents: [], exceptions: [] });
    expect(html).not.toContain("<table");
    expect(html).toContain("No agent activity in this window.");
  });

  test("never emits <details>, CSS grid, or light-dark() — the exact patterns Gmail flattens", () => {
    const html = renderEmailDigest(report);
    expect(html).not.toContain("<details");
    expect(html).not.toContain("<summary");
    expect(html).not.toContain("display: grid");
    expect(html).not.toContain("display:grid");
    expect(html).not.toContain("light-dark(");
    expect(html).not.toContain("<style");
  });

  test("escapes HTML in agent-controlled fields", () => {
    const hostile = agent({ displayName: "<img src=x onerror=alert(1)>" });
    const html = renderEmailDigest({ ...report, agents: [hostile], exceptions: [] });
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});
```

- [ ] **Step 2: Run the tests to check them against the Task 1 implementation**

Run: `bun test tests/digest.test.ts`
Expected: since Task 1 Step 5 already implements the full renderer (`exceptionsSection`, `agentRow`, `renderEmailDigest`), most of these should PASS immediately — this run is a verification pass, not a red/green cycle. Scrutinize any FAIL closely: confirm the exact expected rollup string against `rollupLine`'s actual output (`rollupCounts` counts `commits`/`files` only from attributed commits/filesTouched across all `report.agents`, so with one attributed commit and one file touched total, `"2 agents: 1 needs_human — 1 commit, 1 file touched"` is correct — adjust the literal if the real output differs) before assuming the implementation is wrong.

- [ ] **Step 3: Fix `src/render/digest.ts` until all tests pass**

Iterate on Step 1/Task 1's implementation only if a test reveals a real mismatch (e.g. exact commit/file pluralization, exact rollup string). Do not change test expectations to match a wrong implementation — cross-check against `src/render/rollup.ts:39-49` and `src/status.ts:8-19` for what the correct output should be.

- [ ] **Step 4: Run the full test file to confirm everything passes**

Run: `bun test tests/digest.test.ts`
Expected: PASS (11 tests: 4 from Task 1 + 7 from this task).

- [ ] **Step 5: Commit**

```bash
git add tests/digest.test.ts src/render/digest.ts
git commit -m "test: cover renderEmailDigest rollup/exceptions/rows/escaping (asl-3de)"
```

---

### Task 3: MIME attachment support in `src/email.ts`

**Files:**
- Modify: `src/email.ts:82-128` (`MimeInput`, `buildMimeMessage`), `src/email.ts:197-246` (`sendReportEmail`)
- Test: `tests/email.test.ts`

**Interfaces:**
- Consumes: `quotedPrintable`, `encodeHeaderValue`, `rfc5322Date` (all already in `src/email.ts`, unchanged).
- Produces: `MimeAttachment` type (`{ filename: string; content: string; contentType?: string }`), `MimeInput.attachment?: MimeAttachment`, `MimeInput.mixedBoundary?: string`, and `sendReportEmail(email, subject, text, html, deps, attachment?: MimeAttachment)` — the 6th param consumed by Task 4 (CLI wiring).

- [ ] **Step 1: Write the failing attachment tests for `buildMimeMessage`**

In `tests/email.test.ts`, inside `describe("buildMimeMessage", ...)` (after the existing two tests, before its closing `});`), add:
```ts
  describe("with an attachment", () => {
    const withAttachment = {
      ...input,
      mixedBoundary: "=_asl-mixed-boundary",
      attachment: { filename: "2026-07-13.html", content: "<h1>Full report</h1>" },
    };

    test("wraps the alternative part in multipart/mixed and appends a base64 attachment part", () => {
      const msg = buildMimeMessage(withAttachment);
      expect(msg).toContain('Content-Type: multipart/mixed; boundary="=_asl-mixed-boundary"');
      expect(msg).toContain("--=_asl-mixed-boundary");
      expect(msg).toContain('Content-Type: multipart/alternative; boundary="=_asl-test-boundary"');
      expect(msg).toContain('Content-Type: text/html; charset=utf-8; name="2026-07-13.html"');
      expect(msg).toContain("Content-Transfer-Encoding: base64");
      expect(msg).toContain('Content-Disposition: attachment; filename="2026-07-13.html"');
      expect(msg.endsWith("--=_asl-mixed-boundary--\r\n")).toBe(true);
    });

    test("attachment body is base64 of the exact content, decodable back to the original", () => {
      const msg = buildMimeMessage(withAttachment);
      const marker = 'Content-Disposition: attachment; filename="2026-07-13.html"\r\n\r\n';
      const afterHeader = msg.slice(msg.indexOf(marker) + marker.length);
      const b64 = afterHeader.split("\r\n--=_asl-mixed-boundary--")[0]!;
      expect(Buffer.from(b64.replaceAll("\r\n", ""), "base64").toString("utf8")).toBe("<h1>Full report</h1>");
    });

    test("without an attachment, no multipart/mixed wrapper appears", () => {
      expect(buildMimeMessage(input)).not.toContain("multipart/mixed");
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/email.test.ts`
Expected: FAIL — `TS2353`-style excess-property error at type-check time is not how Bun runs tests, so instead expect assertion failures: the new tests fail because `buildMimeMessage` doesn't yet read `attachment`/`mixedBoundary` and never emits `multipart/mixed`.

- [ ] **Step 3: Implement attachment support in `src/email.ts`**

Replace the `MimeInput` interface (`src/email.ts:82-91`) with:
```ts
export interface MimeAttachment {
  filename: string;
  content: string;      // UTF-8 text (e.g. the full HTML report); sent as base64
  contentType?: string; // default: text/html
}

export interface MimeInput {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  date: Date;
  messageId: string;
  boundary: string;          // multipart/alternative boundary
  attachment?: MimeAttachment;
  mixedBoundary?: string;    // multipart/mixed boundary — required when attachment is set
}
```

Replace `buildMimeMessage` (`src/email.ts:103-128`, including its leading comment) with:
```ts
// RFC 2045 base64, hard-wrapped at 76 chars so a large attachment body never
// produces one unbounded line.
function base64Wrap(s: string): string {
  const b64 = Buffer.from(s, "utf8").toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join("\r\n");
}

function alternativePart(boundary: string, text: string, html: string): string[] {
  return [
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    quotedPrintable(text),
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    quotedPrintable(html),
    `--${boundary}--`,
  ];
}

// Deterministic MIME assembly — date, message-id, and both boundaries are
// inputs so tests can pin the whole message. With no attachment this is a
// bare multipart/alternative, byte-identical to the pre-attachment format;
// with one, that same part is wrapped in multipart/mixed alongside a
// base64-encoded attachment part.
export function buildMimeMessage(m: MimeInput): string {
  const headers = [
    `From: ${m.from}`,
    `To: ${m.to}`,
    `Subject: ${encodeHeaderValue(m.subject)}`,
    `Date: ${rfc5322Date(m.date)}`,
    `Message-ID: <${m.messageId}>`,
    "MIME-Version: 1.0",
  ];
  const alt = alternativePart(m.boundary, m.text, m.html);
  if (!m.attachment) {
    return [...headers, ...alt, ""].join("\r\n");
  }
  const mixedBoundary = m.mixedBoundary!;
  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
    "",
    `--${mixedBoundary}`,
    ...alt,
    "",
    `--${mixedBoundary}`,
    `Content-Type: ${m.attachment.contentType ?? "text/html"}; charset=utf-8; name="${m.attachment.filename}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${m.attachment.filename}"`,
    "",
    base64Wrap(m.attachment.content),
    `--${mixedBoundary}--`,
    "",
  ].join("\r\n");
}
```

- [ ] **Step 4: Run the tests to verify they pass, and that the golden no-attachment test still passes byte-for-byte**

Run: `bun test tests/email.test.ts`
Expected: PASS, including the pre-existing "assembles a deterministic multipart/alternative message" test unchanged.

- [ ] **Step 5: Write the failing test for `sendReportEmail` with an attachment**

In `tests/email.test.ts`, inside `describe("sendReportEmail", ...)`, after the "sends a mime message containing subject and both parts" test, add:
```ts
  test("with an attachment, sends a multipart/mixed message carrying the attachment content", () => {
    let eml = "";
    const r = sendReportEmail(
      EMAIL_CFG, "ASL 2026-07-13: 1 blocked", "text body", "<p>digest body</p>",
      {
        env: { ASL_SMTP_PASSWORD: "p" }, keychain: noKeychain, now: NOW,
        exec: (argv) => {
          eml = readFileSync(argv[argv.indexOf("-T") + 1]!, "utf8");
          return { ok: true, stdout: "", stderr: "" };
        },
      },
      { filename: "2026-07-13.html", content: "<h1>Full report</h1>" },
    );
    expect(r.ok).toBe(true);
    expect(eml).toContain("multipart/mixed");
    expect(eml).toContain("<p>digest body</p>");
    expect(eml).toContain('Content-Disposition: attachment; filename="2026-07-13.html"');
  });
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `bun test tests/email.test.ts`
Expected: FAIL — `sendReportEmail` doesn't accept a 6th argument yet, so no attachment ever reaches `buildMimeMessage`, so `eml` never contains `multipart/mixed`.

- [ ] **Step 7: Add the attachment parameter to `sendReportEmail`**

In `src/email.ts`, change the signature (`src/email.ts:197-203`):
```ts
export function sendReportEmail(
  email: EmailConfig,
  subject: string,
  text: string,
  html: string,
  deps: ReportEmailDeps,
): { ok: boolean; message: string } {
```
to:
```ts
export function sendReportEmail(
  email: EmailConfig,
  subject: string,
  text: string,
  html: string,
  deps: ReportEmailDeps,
  attachment?: MimeAttachment,
): { ok: boolean; message: string } {
```
and change the `buildMimeMessage` call (`src/email.ts:212-224`):
```ts
    const stamp = deps.now.getTime();
    const mime = buildMimeMessage({
      from: email.from,
      to: email.to,
      subject,
      text,
      html,
      date: deps.now,
      messageId: `${stamp}.asl@${email.smtpHost}`,
      // "=_" can never occur in quoted-printable output ("=" is only ever
      // followed by hex digits or a soft break), so this boundary is safe.
      boundary: `=_asl-${stamp.toString(36)}`,
    });
```
to:
```ts
    const stamp = deps.now.getTime();
    const mime = buildMimeMessage({
      from: email.from,
      to: email.to,
      subject,
      text,
      html,
      date: deps.now,
      messageId: `${stamp}.asl@${email.smtpHost}`,
      // "=_" can never occur in quoted-printable output ("=" is only ever
      // followed by hex digits or a soft break), so both boundaries are safe.
      boundary: `=_asl-${stamp.toString(36)}`,
      attachment,
      mixedBoundary: attachment ? `=_asl-mix-${stamp.toString(36)}` : undefined,
    });
```

- [ ] **Step 8: Run the full email test file**

Run: `bun test tests/email.test.ts`
Expected: PASS, all tests including every pre-existing one.

- [ ] **Step 9: Commit**

```bash
git add src/email.ts tests/email.test.ts
git commit -m "feat: multipart/mixed attachment support in buildMimeMessage/sendReportEmail (asl-3de)"
```

---

### Task 4: Wire the CLI to send the digest body with the full report attached

**Files:**
- Modify: `src/cli.ts:15` (import), `src/cli.ts:133-149` (email call site)

**Interfaces:**
- Consumes: `renderEmailDigest` (Task 1/2), `sendReportEmail(..., attachment?: MimeAttachment)` (Task 3).
- Produces: none — this is the final integration point; no other task depends on it.

- [ ] **Step 1: Add the import**

In `src/cli.ts`, after line 10 (`import { renderHtml, HTML_LAYOUTS, type HtmlLayout } from "./render/html";`), add:
```ts
import { renderEmailDigest } from "./render/digest";
```

- [ ] **Step 2: Send the digest as the body and the full report as an attachment**

Replace the email block (`src/cli.ts:133-149`):
```ts
  if (config.email && !values["no-email"]) {
    const statuses = statusSummary(report);
    // Pure ASCII: an em dash would make the whole subject one RFC 2047
    // encoded word, and a populated status list pushes that past the
    // 75-char encoded-word limit.
    const subject = `ASL - ${day}${statuses ? `: ${statuses}` : ""}`;
    // Email is best-effort and must never block --open below; sendReportEmail
    // itself never throws, so no try/catch is needed here.
    const r = sendReportEmail(config.email, subject, md, html, {
      env: process.env,
      keychain: macKeychainLookup,
      exec: spawnExec,
      now,
    });
    if (r.ok) console.log(r.message);
    else console.error(`warning: ${r.message}`);
  }
```
with:
```ts
  if (config.email && !values["no-email"]) {
    const statuses = statusSummary(report);
    // Pure ASCII: an em dash would make the whole subject one RFC 2047
    // encoded word, and a populated status list pushes that past the
    // 75-char encoded-word limit.
    const subject = `ASL - ${day}${statuses ? `: ${statuses}` : ""}`;
    // Gmail flattens the interactive report (details/summary, CSS grid,
    // light-dark() all stripped or unsupported — asl-3de), so the email body
    // is a compact inline-styled digest and the full report rides along as
    // an attachment for anyone who opens it in a browser.
    const digest = redact(renderEmailDigest(report), config.redactPatterns);
    // Email is best-effort and must never block --open below; sendReportEmail
    // itself never throws, so no try/catch is needed here.
    const r = sendReportEmail(
      config.email, subject, md, digest,
      { env: process.env, keychain: macKeychainLookup, exec: spawnExec, now },
      { filename: `${day}.html`, content: html },
    );
    if (r.ok) console.log(r.message);
    else console.error(`warning: ${r.message}`);
  }
```

- [ ] **Step 3: Run the full test suite**

Run: `bun test`
Expected: PASS, 297+ tests (the 293 pre-existing plus the new digest and email-attachment tests from Tasks 1-3; exact count will be higher — confirm no regressions, not an exact number).

- [ ] **Step 4: Type-check**

Run: `bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts
git commit -m "feat: email digest body with full report attached (asl-3de)"
```

- [ ] **Step 6: Manual live verification (confirm with user before sending)**

This step sends a real email through the user's configured Gmail account — confirm before running. If approved:

Run: `bun run src/cli.ts report`

Then check the inbox at the configured `to` address: the body should be the compact digest (rollup line, exceptions, one row per agent — no walls of raw JSON, colors rendering via fixed hex, table rows readable on mobile), and the email should carry one `.html` attachment (`${day}.html`) that opens as the full interactive report in a browser. This mirrors the live-verification method already used for asl-533 and the reference artifacts already on file (`~/Downloads/*2026-07-14*.eml`, the Gmail print PDF) — compare the new digest against those to confirm the specific failure modes (raw `<details>` walls, missing colors, broken grid) are gone.

---

## Self-Review Notes

- **Spec coverage:** rollup line (Task 1 Step 5, `rollupLine` reuse) ✓; exceptions w/ one-line context (Task 1 Step 5 `exceptionsSection`, tested Task 2) ✓; one row per agent — name, status, commit/file counts, standup lead sentence (Task 1 Step 5 `agentRow`, tested Task 2) ✓; phone-friendly / no walls (inline styles, table layout, no `<details>`) ✓; full interactive report attached via `multipart/mixed` (Task 3) ✓; CLI wiring so the digest is actually what gets sent (Task 4) ✓.
- **Placeholder scan:** no TBD/TODO; every step has complete code; test steps show full assertions, not descriptions.
- **Type consistency:** `MimeAttachment` defined once in `src/email.ts` (Task 3 Step 3) and referenced by name in Task 4's CLI call site (structural literal `{ filename, content }` matches the interface); `renderEmailDigest(report: Report): string` and `leadSentence(standup: string): string` signatures are identical between their Task 1 definition and every later reference.
