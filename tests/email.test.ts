import { describe, expect, test } from "bun:test";
import type { KeychainLookup } from "../src/apikey";
import { buildMimeMessage, encodeHeaderValue, quotedPrintable, resolveSmtpPassword } from "../src/email";

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

