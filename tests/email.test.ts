import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { KeychainLookup } from "../src/apikey";
import type { EmailConfig } from "../src/config";
import {
  buildMimeMessage,
  encodeHeaderValue,
  quotedPrintable,
  resolveSmtpPassword,
  sendEmail,
  sendReportEmail,
  type Exec,
} from "../src/email";

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

  test("trailing space at the wrap boundary still keeps lines within 76 chars", () => {
    const encoded = quotedPrintable("x".repeat(74) + " \ny");
    for (const line of encoded.split("\r\n")) expect(line.length).toBeLessThanOrEqual(76);
    expect(encoded).toBe(`${"x".repeat(74)}=\r\n=20\r\ny`);
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

const TARGET = { host: "smtp.gmail.com", port: 465, from: "gd@example.com", to: "gd@example.com" };

describe("sendEmail", () => {
  test("invokes curl with smtps url, envelope args, and temp files — password not in argv", () => {
    let seen: { argv: string[]; cfg: string; eml: string } | null = null;
    const exec: Exec = (argv) => {
      const cfgPath = argv[argv.indexOf("-K") + 1]!;
      const emlPath = argv[argv.indexOf("-T") + 1]!;
      seen = { argv, cfg: readFileSync(cfgPath, "utf8"), eml: readFileSync(emlPath, "utf8") };
      return { ok: true, stdout: "", stderr: "" };
    };
    const r = sendEmail(TARGET, "app-pass", "MIME BODY", exec);
    expect(r).toEqual({ ok: true });
    expect(seen!.argv.slice(0, 6)).toEqual([
      "/usr/bin/curl", "-sS", "--max-time", "60", "--url", "smtps://smtp.gmail.com:465",
    ]);
    expect(seen!.argv).toContain("--mail-from");
    expect(seen!.argv).toContain("--mail-rcpt");
    expect(seen!.argv.join(" ")).not.toContain("app-pass");
    expect(seen!.cfg).toBe('user = "gd@example.com:app-pass"\n');
    expect(seen!.eml).toBe("MIME BODY");
  });

  test("escapes quotes and backslashes in the curl config credential", () => {
    let cfg = "";
    const exec: Exec = (argv) => {
      cfg = readFileSync(argv[argv.indexOf("-K") + 1]!, "utf8");
      return { ok: true, stdout: "", stderr: "" };
    };
    sendEmail(TARGET, 'p"w\\d', "m", exec);
    expect(cfg).toBe('user = "gd@example.com:p\\"w\\\\d"\n');
  });

  test("cleans up the temp dir on success and on failure", () => {
    const dirs: string[] = [];
    const capture =
      (ok: boolean): Exec =>
      (argv) => {
        dirs.push(argv[argv.indexOf("-K") + 1]!);
        return { ok, stdout: "", stderr: ok ? "" : "curl: (67) auth failed" };
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
    const exec: Exec = () => ({ ok: false, stdout: "", stderr: "curl: (67) Login denied\n" });
    expect(sendEmail(TARGET, "p", "m", exec)).toEqual({ ok: false, error: "curl: (67) Login denied" });
  });

  test("falls back to a generic error when stderr is empty", () => {
    const exec: Exec = () => ({ ok: false, stdout: "", stderr: "" });
    expect(sendEmail(TARGET, "p", "m", exec)).toEqual({ ok: false, error: "curl failed" });
  });

  test("rejects a password containing control characters before touching disk", () => {
    let called = false;
    const before = readdirSync(tmpdir()).filter((d) => d.startsWith("asl-email-"));
    const r = sendEmail(TARGET, "bad\npass", "m", () => {
      called = true;
      return { ok: true, stdout: "", stderr: "" };
    });
    expect(r).toEqual({ ok: false, error: "credential or address contains control characters" });
    expect(called).toBe(false);
    const after = readdirSync(tmpdir()).filter((d) => d.startsWith("asl-email-"));
    expect(after.length).toBe(before.length);
  });
});

const EMAIL_CFG: EmailConfig = {
  to: "gd@example.com", from: "gd@example.com", smtpHost: "smtp.gmail.com", smtpPort: 465,
};
const NOW = new Date("2026-07-13T14:30:00Z");

describe("sendReportEmail", () => {
  test("missing password returns the provisioning hint without invoking exec", () => {
    let called = false;
    const r = sendReportEmail(EMAIL_CFG, "subj", "text", "<p>html</p>", {
      env: {}, keychain: noKeychain, now: NOW,
      exec: () => { called = true; return { ok: true, stdout: "", stderr: "" }; },
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
        return { ok: true, stdout: "", stderr: "" };
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
      exec: () => ({ ok: false, stdout: "", stderr: "curl: (67) Login denied" }),
    });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Login denied");
  });

  test("an exec that throws never escapes — returns ok:false with the message", () => {
    const r = sendReportEmail(EMAIL_CFG, "s", "t", "h", {
      env: { ASL_SMTP_PASSWORD: "p" }, keychain: noKeychain, now: NOW,
      exec: () => {
        throw new Error("spawn exploded");
      },
    });
    expect(r).toEqual({ ok: false, message: "email: spawn exploded" });
  });

  test("an unprintable throwable (String() itself throws) still never escapes", () => {
    // Object.create(null) has no toString/valueOf, so String(e) throws
    // "Cannot convert object to primitive value" — the catch's formatter
    // must survive even that.
    const r = sendReportEmail(EMAIL_CFG, "s", "t", "h", {
      env: {}, now: NOW,
      keychain: () => {
        throw Object.create(null);
      },
      exec: () => ({ ok: true, stdout: "", stderr: "" }),
    });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("unprintable error");
  });
});

