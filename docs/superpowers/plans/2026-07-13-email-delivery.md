# Email Delivery of the Morning Report (asl-533) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `asl report` emails the rendered morning report (multipart markdown + HTML) via Gmail SMTP when an `[email]` config section is present.

**Architecture:** A new `src/email.ts` owns everything email: SMTP password resolution (env → keychain, mirroring `resolveApiKey`), pure MIME assembly, a curl `smtps://` shell-out behind an injected exec seam, and a `sendReportEmail` orchestrator that `src/cli.ts` calls after writing report files. Config gains an optional `email` section; doctor gains two conditional checks. Send failures are non-fatal.

**Tech Stack:** Bun, TypeScript, macOS `curl` (built-in, supports smtps), macOS `security` CLI via existing `KeychainLookup`.

**Spec:** `docs/superpowers/specs/2026-07-13-email-delivery-design.md`

## Global Constraints

- No new runtime dependencies — `smol-toml` stays the only one. SMTP goes through system `curl`.
- All external effects (keychain, subprocess) behind injected function seams; tests never touch network, real keychain, or real curl.
- TOML config keys are snake_case (`smtp_host`), mapped to camelCase in `Config`.
- Keychain convention: service `gmail-app-password`, account `asl`; code never writes to the keychain.
- Send failures warn on stderr; the report run still exits 0.
- Do not mention Claude in git commit messages. Commit format: `feat: <what> (asl-533)` / `test: …` matching recent history.
- Run `bun test` after every task; all tests must pass before each commit.
- Work on branch `asl-533-email` off `main`. Do not push; do not run `bd`.

---

### Task 0: Branch

- [ ] **Step 1: Create the working branch**

```bash
cd /Users/gd/github/agent-status-ledger
git checkout -b asl-533-email main
```

(If executing in a worktree, the worktree should be created on this branch instead.)

---

### Task 1: `EmailConfig` in config

**Files:**
- Modify: `src/config.ts` (interface at lines 9–15, `defaultConfig()` 17–28, `loadConfig` overlay after line 55)
- Test: `tests/config.test.ts` (append)

**Interfaces:**
- Consumes: existing `Config`, `loadConfig` guarded-overlay style.
- Produces: `export interface EmailConfig { to: string; from: string; smtpHost: string; smtpPort: number }`; `Config` gains `email?: EmailConfig`. `defaultConfig()` leaves `email` unset. A `[email]` section with a non-empty string `to` enables the feature; `from` defaults to `to`; `smtp_host` defaults to `"smtp.gmail.com"`; `smtp_port` defaults to `465`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/config.test.ts` (follow the file's existing pattern of writing a TOML string to a temp file and calling `loadConfig(path)` — reuse its existing temp-file helper if one exists, else `mkdtempSync`):

```ts
describe("email config", () => {
  test("absent [email] section leaves email unset", () => {
    const path = writeToml(`reports_dir = "/tmp/r"\n`);
    expect(loadConfig(path).email).toBeUndefined();
  });

  test("minimal [email] with to applies defaults", () => {
    const path = writeToml(`[email]\nto = "gd@example.com"\n`);
    expect(loadConfig(path).email).toEqual({
      to: "gd@example.com",
      from: "gd@example.com",
      smtpHost: "smtp.gmail.com",
      smtpPort: 465,
    });
  });

  test("full [email] section overrides all defaults", () => {
    const path = writeToml(
      `[email]\nto = "a@x.com"\nfrom = "b@y.com"\nsmtp_host = "smtp.other.com"\nsmtp_port = 587\n`,
    );
    expect(loadConfig(path).email).toEqual({
      to: "a@x.com", from: "b@y.com", smtpHost: "smtp.other.com", smtpPort: 587,
    });
  });

  test("[email] without a usable to stays disabled", () => {
    expect(loadConfig(writeToml(`[email]\nfrom = "b@y.com"\n`)).email).toBeUndefined();
    expect(loadConfig(writeToml(`[email]\nto = 42\n`)).email).toBeUndefined();
    expect(loadConfig(writeToml(`[email]\nto = "  "\n`)).email).toBeUndefined();
  });

  test("wrong-typed optional email fields fall back to defaults", () => {
    const path = writeToml(`[email]\nto = "a@x.com"\nsmtp_port = "not-a-number"\nfrom = 7\n`);
    expect(loadConfig(path).email).toEqual({
      to: "a@x.com", from: "a@x.com", smtpHost: "smtp.gmail.com", smtpPort: 465,
    });
  });
});
```

(`writeToml` = whatever helper the file already uses to persist a TOML string to a temp path; add a small local one only if none exists.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/config.test.ts`
Expected: new tests FAIL (`email` is `undefined` vs expected object / property missing).

- [ ] **Step 3: Implement**

In `src/config.ts`:

```ts
export interface EmailConfig {
  to: string;
  from: string;
  smtpHost: string;
  smtpPort: number;
}
```

Add to `Config`:

```ts
  email?: EmailConfig;   // absent = email delivery off
```

`defaultConfig()` is unchanged (no `email` key). In `loadConfig`, after the `connectors` block (line 55), before `redact_patterns`:

```ts
  const em = raw.email as Record<string, unknown> | undefined;
  if (typeof em?.to === "string" && em.to.trim()) {
    c.email = {
      to: em.to,
      from: typeof em.from === "string" && em.from.trim() ? em.from : em.to,
      smtpHost: typeof em.smtp_host === "string" ? em.smtp_host : "smtp.gmail.com",
      smtpPort: typeof em.smtp_port === "number" ? em.smtp_port : 465,
    };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test`
Expected: full suite PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: optional [email] config section with gmail defaults (asl-533)"
```

---

### Task 2: SMTP password resolution

**Files:**
- Create: `src/email.ts`
- Create: `tests/email.test.ts`

**Interfaces:**
- Consumes: `KeychainLookup` type from `src/apikey.ts`.
- Produces (from `src/email.ts`):
  - `export const SMTP_KEYCHAIN_SERVICE = "gmail-app-password"`
  - `export const SMTP_KEYCHAIN_ACCOUNT = "asl"`
  - `export interface ResolvedPassword { password: string; source: string }`
  - `export function resolveSmtpPassword(env: Record<string, string | undefined>, keychain: KeychainLookup): ResolvedPassword | null`

- [ ] **Step 1: Write the failing tests**

Create `tests/email.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { KeychainLookup } from "../src/apikey";
import { resolveSmtpPassword } from "../src/email";

const noKeychain: KeychainLookup = () => null;
function fakeKeychain(entries: Record<string, string>): KeychainLookup {
  return (service, account) => entries[`${service}/${account ?? ""}`] ?? null;
}

describe("resolveSmtpPassword", () => {
  test("prefers ASL_SMTP_PASSWORD env var over keychain", () => {
    const r = resolveSmtpPassword(
      { ASL_SMTP_PASSWORD: "env-pass" },
      fakeKeychain({ "gmail-app-password/asl": "chain-pass" }),
    );
    expect(r).toEqual({ password: "env-pass", source: "ASL_SMTP_PASSWORD env var" });
  });

  test("falls back to keychain gmail-app-password/asl", () => {
    const r = resolveSmtpPassword({}, fakeKeychain({ "gmail-app-password/asl": "chain-pass" }));
    expect(r).toEqual({
      password: "chain-pass",
      source: "keychain gmail-app-password (account: asl)",
    });
  });

  test("returns null when nothing is set", () => {
    expect(resolveSmtpPassword({}, noKeychain)).toBeNull();
  });

  test("ignores empty and whitespace-only values", () => {
    expect(resolveSmtpPassword({ ASL_SMTP_PASSWORD: "  " }, noKeychain)).toBeNull();
    expect(resolveSmtpPassword({}, fakeKeychain({ "gmail-app-password/asl": "\n" }))).toBeNull();
  });

  test("trims the resolved password", () => {
    const r = resolveSmtpPassword({}, fakeKeychain({ "gmail-app-password/asl": "pass\n" }));
    expect(r?.password).toBe("pass");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/email.test.ts`
Expected: FAIL — module `../src/email` not found.

- [ ] **Step 3: Implement**

Create `src/email.ts`:

```ts
// Email delivery of the morning report (asl-533): Gmail SMTP via the system
// curl. Same keychain convention as src/apikey.ts — one service name shared
// across projects, account = project name. Code never writes to the keychain.
import type { KeychainLookup } from "./apikey";

export const SMTP_KEYCHAIN_SERVICE = "gmail-app-password";
export const SMTP_KEYCHAIN_ACCOUNT = "asl";

export interface ResolvedPassword {
  password: string;
  source: string;
}

export function resolveSmtpPassword(
  env: Record<string, string | undefined>,
  keychain: KeychainLookup,
): ResolvedPassword | null {
  const candidates: Array<[() => string | null | undefined, string]> = [
    [() => env.ASL_SMTP_PASSWORD, "ASL_SMTP_PASSWORD env var"],
    [
      () => keychain(SMTP_KEYCHAIN_SERVICE, SMTP_KEYCHAIN_ACCOUNT),
      `keychain ${SMTP_KEYCHAIN_SERVICE} (account: ${SMTP_KEYCHAIN_ACCOUNT})`,
    ],
  ];
  for (const [get, source] of candidates) {
    const password = get()?.trim();
    if (password) return { password, source };
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test`
Expected: full suite PASS.

- [ ] **Step 5: Commit**

```bash
git add src/email.ts tests/email.test.ts
git commit -m "feat: smtp app-password resolution (env, keychain) (asl-533)"
```

---

### Task 3: MIME message assembly

**Files:**
- Modify: `src/email.ts`
- Test: `tests/email.test.ts` (append)

**Interfaces:**
- Produces (all exported from `src/email.ts`):
  - `export function quotedPrintable(s: string): string` — RFC 2045 §6.7: UTF-8 bytes, `=XX` escapes, soft line breaks keeping lines ≤76 chars, trailing space/tab before a hard break encoded.
  - `export function encodeHeaderValue(s: string): string` — returns input unchanged if printable-ASCII, else one RFC 2047 `=?UTF-8?B?…?=` encoded word.
  - `export interface MimeInput { from: string; to: string; subject: string; text: string; html: string; date: Date; messageId: string; boundary: string }`
  - `export function buildMimeMessage(m: MimeInput): string` — CRLF line endings, `multipart/alternative`, text part then html part, both `quoted-printable`. Deterministic: date/messageId/boundary are inputs.

- [ ] **Step 1: Write the failing tests**

Append to `tests/email.test.ts`:

```ts
import { buildMimeMessage, encodeHeaderValue, quotedPrintable } from "../src/email";

describe("quotedPrintable", () => {
  test("passes plain ASCII through", () => {
    expect(quotedPrintable("hello world")).toBe("hello world");
  });

  test("escapes = and non-ASCII as UTF-8 byte pairs", () => {
    expect(quotedPrintable("a=b")).toBe("a=3Db");
    expect(quotedPrintable("café")).toBe("caf=C3=A9");
  });

  test("normalizes newlines to CRLF hard breaks", () => {
    expect(quotedPrintable("a\nb")).toBe("a\r\nb");
    expect(quotedPrintable("a\r\nb")).toBe("a\r\nb");
  });

  test("encodes trailing space/tab before a hard break", () => {
    expect(quotedPrintable("a \nb")).toBe("a=20\r\nb");
    expect(quotedPrintable("a\t\nb")).toBe("a=09\r\nb");
  });

  test("soft-wraps so no line exceeds 76 characters", () => {
    const encoded = quotedPrintable("x".repeat(200));
    for (const line of encoded.split("\r\n")) expect(line.length).toBeLessThanOrEqual(76);
    // soft breaks are reversible: stripping =\r\n restores the input
    expect(encoded.replaceAll("=\r\n", "")).toBe("x".repeat(200));
  });
});

describe("encodeHeaderValue", () => {
  test("leaves printable ASCII unchanged", () => {
    expect(encodeHeaderValue("ASL 2026-07-13: 2 blocked")).toBe("ASL 2026-07-13: 2 blocked");
  });

  test("encodes non-ASCII as an RFC 2047 UTF-8 encoded word", () => {
    expect(encodeHeaderValue("ASL — report")).toBe(
      `=?UTF-8?B?${Buffer.from("ASL — report", "utf8").toString("base64")}?=`,
    );
  });
});

describe("buildMimeMessage", () => {
  const input = {
    from: "gd@example.com",
    to: "gd@example.com",
    subject: "ASL — 2026-07-13: 1 blocked",
    text: "# Report\n1 blocked",
    html: "<h1>Report</h1>",
    date: new Date("2026-07-13T14:30:00Z"),
    messageId: "1783948200000.asl@smtp.gmail.com",
    boundary: "=_asl-test-boundary",
  };

  test("assembles a deterministic multipart/alternative message", () => {
    expect(buildMimeMessage(input)).toBe(
      [
        "From: gd@example.com",
        "To: gd@example.com",
        `Subject: ${encodeHeaderValue("ASL — 2026-07-13: 1 blocked")}`,
        "Date: Mon, 13 Jul 2026 14:30:00 +0000",
        "Message-ID: <1783948200000.asl@smtp.gmail.com>",
        "MIME-Version: 1.0",
        'Content-Type: multipart/alternative; boundary="=_asl-test-boundary"',
        "",
        "--=_asl-test-boundary",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: quoted-printable",
        "",
        "# Report\r\n1 blocked",
        "--=_asl-test-boundary",
        "Content-Type: text/html; charset=utf-8",
        "Content-Transfer-Encoding: quoted-printable",
        "",
        "<h1>Report</h1>",
        "--=_asl-test-boundary--",
        "",
      ].join("\r\n"),
    );
  });

  test("uses CRLF for every line ending", () => {
    const msg = buildMimeMessage(input);
    expect(msg.includes("\n")).toBe(true);
    expect(msg.replaceAll("\r\n", "").includes("\n")).toBe(false);
  });
});
```

(Note the expected `Date:` value — the implementation formats as RFC 5322 with a `+0000` zone, not `toUTCString()`'s `GMT`. 2026-07-13 is a Monday.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/email.test.ts`
Expected: FAIL — `quotedPrintable` etc. not exported.

- [ ] **Step 3: Implement**

Append to `src/email.ts`:

```ts
// RFC 2045 §6.7 quoted-printable over UTF-8 bytes. Lines capped at 76 chars
// via soft breaks; trailing space/tab before a hard break must be encoded.
export function quotedPrintable(s: string): string {
  const bytes = new TextEncoder().encode(s.replaceAll("\r\n", "\n"));
  const lines: string[] = [];
  let line = "";
  const endLine = () => {
    if (line.endsWith(" ")) line = `${line.slice(0, -1)}=20`;
    else if (line.endsWith("\t")) line = `${line.slice(0, -1)}=09`;
    lines.push(line);
    line = "";
  };
  for (const b of bytes) {
    if (b === 0x0a) {
      endLine();
      continue;
    }
    const literal = (b >= 33 && b <= 126 && b !== 61) || b === 32 || b === 9;
    const tok = literal ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, "0")}`;
    if (line.length + tok.length > 75) {
      lines.push(`${line}=`); // soft break
      line = "";
    }
    line += tok;
  }
  endLine();
  return lines.join("\r\n");
}

// RFC 2047 encoded word for header values with non-ASCII (the subject's em
// dash). Subjects here are short, so one word is enough — no 75-char split.
export function encodeHeaderValue(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

export interface MimeInput {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  date: Date;
  messageId: string;
  boundary: string;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// RFC 5322 date, always UTC ("+0000") for determinism.
function rfc5322Date(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${DAYS[d.getUTCDay()]}, ${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`;
}

// Deterministic multipart/alternative assembly — date, message-id, and
// boundary are inputs so tests can pin the whole message.
export function buildMimeMessage(m: MimeInput): string {
  return [
    `From: ${m.from}`,
    `To: ${m.to}`,
    `Subject: ${encodeHeaderValue(m.subject)}`,
    `Date: ${rfc5322Date(m.date)}`,
    `Message-ID: <${m.messageId}>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${m.boundary}"`,
    "",
    `--${m.boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    quotedPrintable(m.text),
    `--${m.boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    quotedPrintable(m.html),
    `--${m.boundary}--`,
    "",
  ].join("\r\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test`
Expected: full suite PASS. If the golden test fails on the `Date:` line, fix the implementation (not the test) — the expected string in the test is correct for 2026-07-13T14:30:00Z.

- [ ] **Step 5: Commit**

```bash
git add src/email.ts tests/email.test.ts
git commit -m "feat: deterministic multipart mime assembly with quoted-printable (asl-533)"
```

---

### Task 4: curl send with temp-file credentials

**Files:**
- Modify: `src/email.ts`
- Test: `tests/email.test.ts` (append)

**Interfaces:**
- Produces (from `src/email.ts`):
  - `export type EmailExec = (argv: string[]) => { ok: boolean; stderr: string }` — like doctor's `Exec` but carries stderr, where curl reports SMTP errors.
  - `export interface SmtpTarget { host: string; port: number; from: string; to: string }`
  - `export function sendEmail(target: SmtpTarget, password: string, mime: string, exec: EmailExec): { ok: boolean; error?: string }`
- Behavior: password goes in a mode-600 curl config file (`-K`), never in argv (argv is visible in `ps`); message uploaded from a temp `.eml` (`-T`); private temp dir removed in `finally`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/email.test.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { sendEmail, type EmailExec } from "../src/email";

const TARGET = { host: "smtp.gmail.com", port: 465, from: "gd@example.com", to: "gd@example.com" };

describe("sendEmail", () => {
  test("invokes curl with smtps url, envelope args, and temp files — password not in argv", () => {
    let seen: { argv: string[]; cfg: string; eml: string } | null = null;
    const exec: EmailExec = (argv) => {
      const cfgPath = argv[argv.indexOf("-K") + 1]!;
      const emlPath = argv[argv.indexOf("-T") + 1]!;
      seen = { argv, cfg: readFileSync(cfgPath, "utf8"), eml: readFileSync(emlPath, "utf8") };
      return { ok: true, stderr: "" };
    };
    const r = sendEmail(TARGET, "app-pass", "MIME BODY", exec);
    expect(r).toEqual({ ok: true });
    expect(seen!.argv.slice(0, 4)).toEqual(["curl", "-sS", "--url", "smtps://smtp.gmail.com:465"]);
    expect(seen!.argv).toContain("--mail-from");
    expect(seen!.argv).toContain("--mail-rcpt");
    expect(seen!.argv.join(" ")).not.toContain("app-pass");
    expect(seen!.cfg).toBe('user = "gd@example.com:app-pass"\n');
    expect(seen!.eml).toBe("MIME BODY");
  });

  test("escapes quotes and backslashes in the curl config credential", () => {
    let cfg = "";
    const exec: EmailExec = (argv) => {
      cfg = readFileSync(argv[argv.indexOf("-K") + 1]!, "utf8");
      return { ok: true, stderr: "" };
    };
    sendEmail(TARGET, 'p"w\\d', "m", exec);
    expect(cfg).toBe('user = "gd@example.com:p\\"w\\\\d"\n');
  });

  test("cleans up the temp dir on success and on failure", () => {
    const dirs: string[] = [];
    const capture =
      (ok: boolean): EmailExec =>
      (argv) => {
        dirs.push(argv[argv.indexOf("-K") + 1]!);
        return { ok, stderr: ok ? "" : "curl: (67) auth failed" };
      };
    sendEmail(TARGET, "p", "m", capture(true));
    sendEmail(TARGET, "p", "m", capture(false));
    for (const d of dirs) expect(existsSync(d)).toBe(false);
  });

  test("cleans up even when exec throws", () => {
    let cfgPath = "";
    expect(() =>
      sendEmail(TARGET, "p", "m", (argv) => {
        cfgPath = argv[argv.indexOf("-K") + 1]!;
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(existsSync(cfgPath)).toBe(false);
  });

  test("returns curl stderr as the error on failure", () => {
    const exec: EmailExec = () => ({ ok: false, stderr: "curl: (67) Login denied\n" });
    expect(sendEmail(TARGET, "p", "m", exec)).toEqual({ ok: false, error: "curl: (67) Login denied" });
  });

  test("falls back to a generic error when stderr is empty", () => {
    const exec: EmailExec = () => ({ ok: false, stderr: "" });
    expect(sendEmail(TARGET, "p", "m", exec)).toEqual({ ok: false, error: "curl failed" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/email.test.ts`
Expected: FAIL — `sendEmail` not exported.

- [ ] **Step 3: Implement**

In `src/email.ts`, add imports at the top:

```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
```

Append:

```ts
// Doctor's Exec discards stderr; curl reports SMTP failures there, so email
// gets its own seam shape.
export type EmailExec = (argv: string[]) => { ok: boolean; stderr: string };

export interface SmtpTarget {
  host: string;
  port: number;
  from: string;
  to: string;
}

// Shells out to the system curl (macOS builds include smtps). The password
// rides in a mode-600 curl config file, not argv, so it never shows in ps.
export function sendEmail(
  target: SmtpTarget,
  password: string,
  mime: string,
  exec: EmailExec,
): { ok: boolean; error?: string } {
  const dir = mkdtempSync(join(tmpdir(), "asl-email-")); // mkdtemp dirs are mode 700
  try {
    const cfgPath = join(dir, "curl.cfg");
    const emlPath = join(dir, "message.eml");
    const cred = `${target.from}:${password}`.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    writeFileSync(cfgPath, `user = "${cred}"\n`, { mode: 0o600 });
    writeFileSync(emlPath, mime, { mode: 0o600 });
    const r = exec([
      "curl", "-sS",
      "--url", `smtps://${target.host}:${target.port}`,
      "--mail-from", target.from,
      "--mail-rcpt", target.to,
      "-K", cfgPath,
      "-T", emlPath,
    ]);
    return r.ok ? { ok: true } : { ok: false, error: r.stderr.trim() || "curl failed" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test`
Expected: full suite PASS.

- [ ] **Step 5: Commit**

```bash
git add src/email.ts tests/email.test.ts
git commit -m "feat: curl smtps send with keychain-safe temp-file credentials (asl-533)"
```

---

### Task 5: `sendReportEmail` orchestrator

**Files:**
- Modify: `src/email.ts`
- Test: `tests/email.test.ts` (append)

**Interfaces:**
- Consumes: `EmailConfig` from `src/config.ts`; everything above.
- Produces (from `src/email.ts`):
  - `export interface ReportEmailDeps { env: Record<string, string | undefined>; keychain: KeychainLookup; exec: EmailExec; now: Date }`
  - `export function sendReportEmail(email: EmailConfig, subject: string, text: string, html: string, deps: ReportEmailDeps): { ok: boolean; message: string }`
- Behavior: resolves password (missing → `ok: false` with the `security add-generic-password` hint), builds the MIME message (message-id/boundary derived from `deps.now` — no `Date.now()` inside), sends, and returns a one-line human message either way. Never throws for send-path failures.

- [ ] **Step 1: Write the failing tests**

Append to `tests/email.test.ts`:

```ts
import type { EmailConfig } from "../src/config";
import { sendReportEmail } from "../src/email";

const EMAIL_CFG: EmailConfig = {
  to: "gd@example.com", from: "gd@example.com", smtpHost: "smtp.gmail.com", smtpPort: 465,
};
const NOW = new Date("2026-07-13T14:30:00Z");

describe("sendReportEmail", () => {
  test("missing password returns the provisioning hint without invoking exec", () => {
    let called = false;
    const r = sendReportEmail(EMAIL_CFG, "subj", "text", "<p>html</p>", {
      env: {}, keychain: noKeychain, now: NOW,
      exec: () => { called = true; return { ok: true, stderr: "" }; },
    });
    expect(called).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("security add-generic-password -s gmail-app-password -a asl");
  });

  test("sends a mime message containing subject and both parts", () => {
    let eml = "";
    const r = sendReportEmail(EMAIL_CFG, "ASL 2026-07-13: 1 blocked", "text body", "<p>html body</p>", {
      env: { ASL_SMTP_PASSWORD: "p" }, keychain: noKeychain, now: NOW,
      exec: (argv) => {
        eml = readFileSync(argv[argv.indexOf("-T") + 1]!, "utf8");
        return { ok: true, stderr: "" };
      },
    });
    expect(r.ok).toBe(true);
    expect(r.message).toContain("gd@example.com");
    expect(eml).toContain("Subject: ASL 2026-07-13: 1 blocked");
    expect(eml).toContain("text body");
    expect(eml).toContain("<p>html body</p>");
    expect(eml).toContain("multipart/alternative");
  });

  test("send failure surfaces the curl error in the message", () => {
    const r = sendReportEmail(EMAIL_CFG, "s", "t", "h", {
      env: { ASL_SMTP_PASSWORD: "p" }, keychain: noKeychain, now: NOW,
      exec: () => ({ ok: false, stderr: "curl: (67) Login denied" }),
    });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Login denied");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/email.test.ts`
Expected: FAIL — `sendReportEmail` not exported.

- [ ] **Step 3: Implement**

In `src/email.ts`, add `import type { EmailConfig } from "./config";` and append:

```ts
export interface ReportEmailDeps {
  env: Record<string, string | undefined>;
  keychain: KeychainLookup;
  exec: EmailExec;
  now: Date;
}

// One-call orchestration for the CLI: resolve password → build MIME → send.
// Always returns a printable one-liner; the caller decides log vs warn.
export function sendReportEmail(
  email: EmailConfig,
  subject: string,
  text: string,
  html: string,
  deps: ReportEmailDeps,
): { ok: boolean; message: string } {
  const resolved = resolveSmtpPassword(deps.env, deps.keychain);
  if (!resolved) {
    return {
      ok: false,
      message:
        "email: no SMTP password — set ASL_SMTP_PASSWORD or run: " +
        `security add-generic-password -s ${SMTP_KEYCHAIN_SERVICE} -a ${SMTP_KEYCHAIN_ACCOUNT} -w "<gmail app password>"`,
    };
  }
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
  const r = sendEmail(
    { host: email.smtpHost, port: email.smtpPort, from: email.from, to: email.to },
    resolved.password,
    mime,
    deps.exec,
  );
  return r.ok
    ? { ok: true, message: `emailed report to ${email.to} (password from ${resolved.source})` }
    : { ok: false, message: `email: send to ${email.to} failed — ${r.error}` };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test`
Expected: full suite PASS.

- [ ] **Step 5: Commit**

```bash
git add src/email.ts tests/email.test.ts
git commit -m "feat: sendReportEmail orchestrator (asl-533)"
```

---

### Task 6: CLI integration

**Files:**
- Modify: `src/cli.ts` (USAGE line 16, options 54–60, report flow after line 120)
- Test: `tests/cli.test.ts` (append, pre-I/O paths only)

**Interfaces:**
- Consumes: `sendReportEmail`, `EmailExec` from `src/email.ts`; `rollupCounts` from `src/render/rollup.ts`; `config.email` from Task 1.
- Produces: `--no-email` flag; auto-send after report files are written; subject `ASL — YYYY-MM-DD: <counts>`; non-fatal failures.

- [ ] **Step 1: Write the failing test**

`tests/cli.test.ts` only spawns the binary for fast pre-I/O paths — follow its existing spawn helper. Append a usage-surface test:

```ts
test("usage mentions --no-email", async () => {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", "not-a-command"], {
    cwd: import.meta.dir + "/..",
    stderr: "pipe",
  });
  await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  expect(stderr).toContain("--no-email");
});
```

(Adapt to the file's existing helper if it has one — match its style.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli.test.ts`
Expected: new test FAILS (usage lacks `--no-email`).

- [ ] **Step 3: Implement**

In `src/cli.ts`:

1. Extend USAGE (line 16):

```ts
const USAGE = `usage: asl report [--since 24h] [--open] [--no-llm] [--no-email] [--out DIR] [--layout ${HTML_LAYOUTS.join("|")}]
       asl doctor`;
```

2. Add to `parseArgs` options (after `"no-llm"`):

```ts
        "no-email": { type: "boolean", default: false },
```

3. Add imports:

```ts
import { sendReportEmail, type EmailExec } from "./email";
import { rollupCounts } from "./render/rollup";
```

4. After the `console.log(\`wrote ...\`)` line (124), before the `--open` handling:

```ts
  if (config.email && !values["no-email"]) {
    const statuses = rollupCounts(report)
      .byStatus.map(({ status, count }) => `${count} ${status}`)
      .join(", ");
    const subject = `ASL — ${day}${statuses ? `: ${statuses}` : ""}`;
    const emailExec: EmailExec = (argv) => {
      try {
        const proc = Bun.spawnSync(argv, { stderr: "pipe" });
        return { ok: proc.exitCode === 0, stderr: proc.stderr.toString() };
      } catch (e) {
        return { ok: false, stderr: String(e) };
      }
    };
    // Email is best-effort: a failed send warns but never fails the run —
    // the written report files and the morning browser tab are the primary
    // delivery, and morning-report.sh must still reach its `open`.
    const r = sendReportEmail(config.email, subject, md, html, {
      env: process.env,
      keychain: macKeychainLookup,
      exec: emailExec,
      now,
    });
    if (r.ok) console.log(r.message);
    else console.error(`warning: ${r.message}`);
  }
```

Note this reuses the already-redacted `md` and `html` strings — the email body must never contain pre-redaction content.

- [ ] **Step 4: Run tests + smoke-test the CLI**

Run: `bun test`
Expected: full suite PASS.

Smoke (no `[email]` in real config → must behave exactly as before):

```bash
bun run src/cli.ts report --no-llm --out /tmp/asl-533-smoke
bun run src/cli.ts report --no-llm --no-email --out /tmp/asl-533-smoke
```

Expected: both write reports normally, no email lines in output, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts tests/cli.test.ts
git commit -m "feat: auto-email report when [email] configured, --no-email opt-out (asl-533)"
```

---

### Task 7: Doctor checks

**Files:**
- Modify: `src/doctor.ts` (add two checks; wire into `runDoctor` at lines 143–158)
- Test: `tests/doctor.test.ts` (append)

**Interfaces:**
- Consumes: `resolveSmtpPassword`, `SMTP_KEYCHAIN_SERVICE`, `SMTP_KEYCHAIN_ACCOUNT` from `src/email.ts`; `Config["email"]` from Task 1.
- Produces (from `src/doctor.ts`):
  - `export function checkEmailConfig(email: Config["email"]): CheckResult`
  - `export function checkEmailPassword(env: DoctorDeps["env"], keychain: KeychainLookup, configured: boolean): CheckResult`
- Behavior: when email is unconfigured both checks return `ok: true` with a "not configured — skipped" detail (matching the disabled-connector pattern at `doctor.ts:109`).

- [ ] **Step 1: Write the failing tests**

Append to `tests/doctor.test.ts`:

```ts
import { checkEmailConfig, checkEmailPassword } from "../src/doctor";
import type { EmailConfig } from "../src/config";

const email: EmailConfig = {
  to: "gd@example.com", from: "gd@example.com", smtpHost: "smtp.gmail.com", smtpPort: 465,
};

describe("checkEmailConfig", () => {
  test("skips when email is not configured", () => {
    const r = checkEmailConfig(undefined);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("not configured");
  });

  test("passes and shows the route for a valid config", () => {
    const r = checkEmailConfig(email);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("smtp.gmail.com:465");
  });

  test("fails on implausible addresses and bad port", () => {
    expect(checkEmailConfig({ ...email, to: "not-an-address" }).ok).toBe(false);
    expect(checkEmailConfig({ ...email, from: "also bad" }).ok).toBe(false);
    expect(checkEmailConfig({ ...email, smtpPort: 0 }).ok).toBe(false);
  });
});

describe("checkEmailPassword", () => {
  test("skips when email is not configured", () => {
    const r = checkEmailPassword({}, noKeychain, false);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("not configured");
  });

  test("passes when the keychain has the app password", () => {
    const keychain: KeychainLookup = (s, a) =>
      s === "gmail-app-password" && a === "asl" ? "pass" : null;
    const r = checkEmailPassword({}, keychain, true);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("keychain");
  });

  test("fails with the add-generic-password hint when missing", () => {
    const r = checkEmailPassword({}, noKeychain, true);
    expect(r.ok).toBe(false);
    expect(r.fix).toContain("security add-generic-password -s gmail-app-password -a asl");
  });
});

describe("runDoctor email wiring", () => {
  // Build deps the same way the file's existing runDoctor tests do (reuse its
  // deps helper if present); only config.email varies here.
  test("includes both email checks when configured", () => {
    const config = { ...defaultConfig(), email };
    const results = runDoctor(makeDeps({ config }));
    const names = results.map((r) => r.name);
    expect(names).toContain("email config");
    expect(names).toContain("gmail app password");
  });

  test("email checks report skipped when unconfigured", () => {
    const results = runDoctor(makeDeps({ config: defaultConfig() }));
    const emailChecks = results.filter((r) => r.name === "email config" || r.name === "gmail app password");
    expect(emailChecks).toHaveLength(2);
    for (const r of emailChecks) {
      expect(r.ok).toBe(true);
      expect(r.detail).toContain("not configured");
    }
  });
});
```

(`makeDeps` = the existing helper the file uses to build `DoctorDeps` for `runDoctor` tests; adapt names to what's actually there.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/doctor.test.ts`
Expected: FAIL — `checkEmailConfig` not exported.

- [ ] **Step 3: Implement**

In `src/doctor.ts`, add to imports:

```ts
import { resolveSmtpPassword, SMTP_KEYCHAIN_ACCOUNT, SMTP_KEYCHAIN_SERVICE } from "./email";
```

Add checks (near `checkConfigFile`):

```ts
const ADDRESS_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function checkEmailConfig(email: Config["email"]): CheckResult {
  const name = "email config";
  if (!email) return { name, ok: true, detail: "email not configured — skipped" };
  const configHint = "fix the [email] section in ~/.config/asl/config.toml";
  if (!ADDRESS_SHAPE.test(email.to)) {
    return { name, ok: false, detail: `email.to "${email.to}" does not look like an address`, fix: configHint };
  }
  if (!ADDRESS_SHAPE.test(email.from)) {
    return { name, ok: false, detail: `email.from "${email.from}" does not look like an address`, fix: configHint };
  }
  if (!Number.isInteger(email.smtpPort) || email.smtpPort < 1 || email.smtpPort > 65535) {
    return { name, ok: false, detail: `smtp_port ${email.smtpPort} is not a valid port`, fix: configHint };
  }
  return { name, ok: true, detail: `${email.from} → ${email.to} via ${email.smtpHost}:${email.smtpPort}` };
}

export function checkEmailPassword(
  env: Record<string, string | undefined>,
  keychain: KeychainLookup,
  configured: boolean,
): CheckResult {
  const name = "gmail app password";
  if (!configured) return { name, ok: true, detail: "email not configured — skipped" };
  const resolved = resolveSmtpPassword(env, keychain);
  return resolved
    ? { name, ok: true, detail: `found via ${resolved.source}` }
    : {
        name,
        ok: false,
        detail: "not found in env (ASL_SMTP_PASSWORD) or keychain",
        fix: `security add-generic-password -s ${SMTP_KEYCHAIN_SERVICE} -a ${SMTP_KEYCHAIN_ACCOUNT} -w "<gmail app password>"`,
      };
}
```

Wire into `runDoctor`'s returned array, after `checkConfigFile(deps.configPath)`:

```ts
    checkEmailConfig(deps.config.email),
    checkEmailPassword(deps.env, deps.keychain, !!deps.config.email),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test`
Expected: full suite PASS. Also run `bun run src/cli.ts doctor` — the two new checks appear (skipped or checking, depending on your real config) and the command still exits sensibly.

- [ ] **Step 5: Commit**

```bash
git add src/doctor.ts tests/doctor.test.ts
git commit -m "feat: doctor checks for email config and gmail app password (asl-533)"
```

---

### Task 8: Docs + final gates

**Files:**
- Modify: `README.md` (configuration section — add `[email]`; usage section — add `--no-email` if flags are listed)

**Interfaces:** none — documentation and verification only.

- [ ] **Step 1: Document the feature**

In `README.md`'s configuration docs, add alongside the existing config keys:

```toml
[email]                        # optional — emails the report after each run
to = "you@example.com"         # required to enable
from = "you@example.com"       # default: same as `to`
smtp_host = "smtp.gmail.com"   # default
smtp_port = 465                # default
```

With setup prose:

> Emails the finished report via SMTP (Gmail by default). One-time setup: create an app password at https://myaccount.google.com/apppasswords (requires 2-Step Verification), then store it in the keychain:
>
> ```bash
> security add-generic-password -s gmail-app-password -a asl -w "<app password>"
> ```
>
> `ASL_SMTP_PASSWORD` overrides the keychain. Skip a send with `--no-email`. `asl doctor` verifies the config and password. Send failures print a warning but never fail the report run.

Match the README's existing tone/format — this is content, not exact copy.

- [ ] **Step 2: Full quality gates**

```bash
bun test
bun run src/cli.ts report --no-llm --out /tmp/asl-533-smoke && echo OK
bun run src/cli.ts doctor; echo "doctor exit: $?"
```

Expected: all tests pass; smoke report writes files and exits 0; doctor renders the two new checks.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: [email] config and gmail app-password setup (asl-533)"
```

---

## Not in this plan (deliberate)

- No real-network integration test — the send path is exercised manually once after merge (`asl report` with real config) as part of verification.
- No changes to `scripts/morning-report.sh` — auto-send happens inside `asl report`.
- No keychain writes, multiple recipients, or non-Gmail providers beyond `smtp_host`/`smtp_port`.
