// Email delivery of the morning report (asl-533): Gmail SMTP via the system
// curl. Same keychain convention as src/apikey.ts — one service name shared
// across projects, account = project name. Code never writes to the keychain.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeychainLookup } from "./apikey";
import type { EmailConfig } from "./config";

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

// RFC 2045 §6.7 quoted-printable over UTF-8 bytes. Lines capped at 76 chars
// via soft breaks; trailing space/tab before a hard break must be encoded.
export function quotedPrintable(s: string): string {
  const bytes = new TextEncoder().encode(s.replaceAll("\r\n", "\n"));
  const lines: string[] = [];
  let line = "";
  const endLine = () => {
    if (line.endsWith(" ") || line.endsWith("\t")) {
      const enc = line.endsWith(" ") ? "=20" : "=09";
      line = line.slice(0, -1);
      if (line.length + enc.length > 76) {
        lines.push(`${line}=`); // soft break before the encoded trailing whitespace
        line = "";
      }
      line += enc;
    }
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

// RFC 2047 encoded word for header values with non-ASCII. The caller keeps
// subjects pure ASCII (see cli.ts), so this path is a safety net for
// non-ASCII input, not the normal route — one encoded word is enough for
// anything realistic, no need for a 75-char split.
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

// Doctor's Exec discards stderr; curl reports SMTP failures there, so email
// gets its own seam shape.
export type EmailExec = (argv: string[]) => { ok: boolean; stderr: string };

export interface SmtpTarget {
  host: string;
  port: number;
  from: string;
  to: string;
}

// Control characters (including CR/LF) have no business in a credential or
// an envelope address; reject them up front rather than trust config.ts and
// callers to have already validated everything that reaches here.
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

// Shells out to the system curl (macOS builds include smtps). The password
// rides in a mode-600 curl config file, not argv, so it never shows in ps.
export function sendEmail(
  target: SmtpTarget,
  password: string,
  mime: string,
  exec: EmailExec,
): { ok: boolean; error?: string } {
  if (
    CONTROL_CHARS.test(password) ||
    CONTROL_CHARS.test(target.host) ||
    CONTROL_CHARS.test(target.from) ||
    CONTROL_CHARS.test(target.to)
  ) {
    return { ok: false, error: "credential or address contains control characters" };
  }
  const dir = mkdtempSync(join(tmpdir(), "asl-email-")); // mkdtemp dirs are mode 700
  try {
    const cfgPath = join(dir, "curl.cfg");
    const emlPath = join(dir, "message.eml");
    const cred = `${target.from}:${password}`.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    writeFileSync(cfgPath, `user = "${cred}"\n`, { mode: 0o600 });
    writeFileSync(emlPath, mime, { mode: 0o600 });
    const r = exec([
      "/usr/bin/curl", "-sS",
      // unattended morning run must never hang on a stalled SMTP connection
      "--max-time", "60",
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
