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
