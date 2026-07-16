import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { KeychainLookup } from "../src/apikey";
import type { EmailConfig } from "../src/config";
import {
  buildMimeMessage,
  emailSubject,
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
  test("prefers ASL_SMTP_PASSWORD env var over keychain", async () => {
    const r = resolveSmtpPassword(
      { ASL_SMTP_PASSWORD: "env-pass" },
      fakeKeychain({ "gmail-app-password/asl": "chain-pass" }),
    );
    expect(r).toEqual({ password: "env-pass", source: "ASL_SMTP_PASSWORD env var" });
  });

  test("falls back to keychain gmail-app-password/asl", async () => {
    const r = resolveSmtpPassword({}, fakeKeychain({ "gmail-app-password/asl": "chain-pass" }));
    expect(r).toEqual({
      password: "chain-pass",
      source: "keychain gmail-app-password (account: asl)",
    });
  });

  test("returns null when nothing is set", async () => {
    expect(resolveSmtpPassword({}, noKeychain)).toBeNull();
  });

  test("ignores empty and whitespace-only values", async () => {
    expect(resolveSmtpPassword({ ASL_SMTP_PASSWORD: "  " }, noKeychain)).toBeNull();
    expect(resolveSmtpPassword({}, fakeKeychain({ "gmail-app-password/asl": "\n" }))).toBeNull();
  });

  test("trims the resolved password", async () => {
    const r = resolveSmtpPassword({}, fakeKeychain({ "gmail-app-password/asl": "pass\n" }));
    expect(r?.password).toBe("pass");
  });

  test("does not touch the keychain when the env var provides the password", async () => {
    let calls = 0;
    const countingKeychain: KeychainLookup = () => {
      calls++;
      return null;
    };
    resolveSmtpPassword({ ASL_SMTP_PASSWORD: "env-pass" }, countingKeychain);
    expect(calls).toBe(0);
  });
});

describe("emailSubject", () => {
  test("appends the status summary after the day when present", async () => {
    expect(emailSubject("2026-07-13", "2 blocked")).toBe("ASL - 2026-07-13: 2 blocked");
  });

  test("omits the colon and summary when there are no statuses", async () => {
    expect(emailSubject("2026-07-13", "")).toBe("ASL - 2026-07-13");
  });

  test("stays pure ASCII (no em dash) so it never needs RFC 2047 encoding", async () => {
    const subject = emailSubject("2026-07-13", "1 blocked, 2 stale");
    expect(/^[\x20-\x7e]*$/.test(subject)).toBe(true);
    expect(encodeHeaderValue(subject)).toBe(subject);
  });
});

describe("quotedPrintable", () => {
  test("passes plain ASCII through", async () => {
    expect(quotedPrintable("hello world")).toBe("hello world");
  });

  test("escapes = and non-ASCII as UTF-8 byte pairs", async () => {
    expect(quotedPrintable("a=b")).toBe("a=3Db");
    expect(quotedPrintable("café")).toBe("caf=C3=A9");
  });

  test("normalizes newlines to CRLF hard breaks", async () => {
    expect(quotedPrintable("a\nb")).toBe("a\r\nb");
    expect(quotedPrintable("a\r\nb")).toBe("a\r\nb");
  });

  test("encodes trailing space/tab before a hard break", async () => {
    expect(quotedPrintable("a \nb")).toBe("a=20\r\nb");
    expect(quotedPrintable("a\t\nb")).toBe("a=09\r\nb");
  });

  test("trailing space at the wrap boundary still keeps lines within 76 chars", async () => {
    const encoded = quotedPrintable("x".repeat(74) + " \ny");
    for (const line of encoded.split("\r\n")) expect(line.length).toBeLessThanOrEqual(76);
    expect(encoded).toBe(`${"x".repeat(74)}=\r\n=20\r\ny`);
  });

  test("soft-wraps so no line exceeds 76 characters", async () => {
    const encoded = quotedPrintable("x".repeat(200));
    for (const line of encoded.split("\r\n")) expect(line.length).toBeLessThanOrEqual(76);
    // soft breaks are reversible: stripping =\r\n restores the input
    expect(encoded.replaceAll("=\r\n", "")).toBe("x".repeat(200));
  });
});

describe("encodeHeaderValue", () => {
  test("leaves printable ASCII unchanged", async () => {
    expect(encodeHeaderValue("ASL 2026-07-13: 2 blocked")).toBe("ASL 2026-07-13: 2 blocked");
  });

  test("encodes non-ASCII as an RFC 2047 UTF-8 encoded word", async () => {
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

  test("assembles a deterministic multipart/alternative message", async () => {
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

  test("uses CRLF for every line ending", async () => {
    const msg = buildMimeMessage(input);
    expect(msg.includes("\n")).toBe(true);
    expect(msg.replaceAll("\r\n", "").includes("\n")).toBe(false);
  });

  describe("with an attachment", () => {
    const withAttachment = {
      ...input,
      attachment: {
        data: { filename: "2026-07-13.html", content: "<h1>Full report</h1>" },
        boundary: "=_asl-mixed-boundary",
      },
    };

    test("wraps the alternative part in multipart/mixed and appends a base64 attachment part", async () => {
      const msg = buildMimeMessage(withAttachment);
      expect(msg).toContain('Content-Type: multipart/mixed; boundary="=_asl-mixed-boundary"');
      expect(msg).toContain("--=_asl-mixed-boundary");
      expect(msg).toContain('Content-Type: multipart/alternative; boundary="=_asl-test-boundary"');
      expect(msg).toContain('Content-Type: text/html; charset=utf-8; name="2026-07-13.html"');
      expect(msg).toContain("Content-Transfer-Encoding: base64");
      expect(msg).toContain('Content-Disposition: attachment; filename="2026-07-13.html"');
      expect(msg.endsWith("--=_asl-mixed-boundary--\r\n")).toBe(true);
    });

    test("attachment body is base64 of the exact content, decodable back to the original", async () => {
      const msg = buildMimeMessage(withAttachment);
      const marker = 'Content-Disposition: attachment; filename="2026-07-13.html"\r\n\r\n';
      const afterHeader = msg.slice(msg.indexOf(marker) + marker.length);
      const b64 = afterHeader.split("\r\n--=_asl-mixed-boundary--")[0]!;
      expect(Buffer.from(b64.replaceAll("\r\n", ""), "base64").toString("utf8")).toBe("<h1>Full report</h1>");
    });

    test("without an attachment, no multipart/mixed wrapper appears", async () => {
      expect(buildMimeMessage(input)).not.toContain("multipart/mixed");
    });

    test("strips a double quote from the filename so it can't break out of the quoted-string", async () => {
      const msg = buildMimeMessage({
        ...withAttachment,
        attachment: { ...withAttachment.attachment, data: { filename: 'a"b.html', content: "x" } },
      });
      expect(msg).toContain('name="ab.html"');
      expect(msg).toContain('filename="ab.html"');
    });

    test("strips CR/LF and other control chars from the filename (no header injection)", async () => {
      const msg = buildMimeMessage({
        ...withAttachment,
        attachment: {
          ...withAttachment.attachment,
          data: { filename: "a\r\nX-Evil: 1\tb\x00.html", content: "x" },
        },
      });
      expect(msg).toContain('filename="aX-Evil: 1b.html"');
      // the injected header text stays inside the quoted filename, not on its
      // own header line
      expect(msg).not.toContain("\r\nX-Evil: 1");
    });

    test("strips a trailing backslash so it can't escape the closing quote", async () => {
      const msg = buildMimeMessage({
        ...withAttachment,
        attachment: { ...withAttachment.attachment, data: { filename: "report\\", content: "x" } },
      });
      // backslash is the MIME quoted-pair escape; a trailing one would turn the
      // closing quote into an escaped literal and swallow the header end
      expect(msg).toContain('filename="report"');
      expect(msg).not.toContain('report\\"');
    });
  });
});

const TARGET = { host: "smtp.gmail.com", port: 465, from: "gd@example.com", to: "gd@example.com" };

describe("sendEmail", () => {
  test("invokes curl with smtps url, envelope args, and temp files — password not in argv", async () => {
    let seen: { argv: string[]; cfg: string; eml: string } | null = null;
    const exec: Exec = async (argv) => {
      const cfgPath = argv[argv.indexOf("-K") + 1]!;
      const emlPath = argv[argv.indexOf("-T") + 1]!;
      seen = { argv, cfg: readFileSync(cfgPath, "utf8"), eml: readFileSync(emlPath, "utf8") };
      return { ok: true, stdout: "", stderr: "" };
    };
    const r = await sendEmail(TARGET, "app-pass", "MIME BODY", exec);
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

  test("escapes quotes and backslashes in the curl config credential", async () => {
    let cfg = "";
    const exec: Exec = async (argv) => {
      cfg = readFileSync(argv[argv.indexOf("-K") + 1]!, "utf8");
      return { ok: true, stdout: "", stderr: "" };
    };
    await sendEmail(TARGET, 'p"w\\d', "m", exec);
    expect(cfg).toBe('user = "gd@example.com:p\\"w\\\\d"\n');
  });

  test("cleans up the temp dir on success and on failure", async () => {
    const dirs: string[] = [];
    const capture =
      (ok: boolean): Exec =>
      async (argv) => {
        dirs.push(argv[argv.indexOf("-K") + 1]!);
        return { ok, stdout: "", stderr: ok ? "" : "curl: (67) auth failed" };
      };
    await sendEmail(TARGET, "p", "m", capture(true));
    await sendEmail(TARGET, "p", "m", capture(false));
    for (const d of dirs) expect(existsSync(d)).toBe(false);
  });

  test("cleans up even when exec throws", async () => {
    let cfgPath = "";
    // async seam: the throw surfaces as a rejection, not a sync throw
    await expect(
      sendEmail(TARGET, "p", "m", async (argv) => {
        cfgPath = argv[argv.indexOf("-K") + 1]!;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(cfgPath)).toBe(false);
  });

  test("returns curl stderr as the error on failure", async () => {
    const exec: Exec = async () => ({ ok: false, stdout: "", stderr: "curl: (67) Login denied\n" });
    expect(await sendEmail(TARGET, "p", "m", exec)).toEqual({ ok: false, error: "curl: (67) Login denied" });
  });

  test("falls back to a generic error when stderr is empty", async () => {
    const exec: Exec = async () => ({ ok: false, stdout: "", stderr: "" });
    expect(await sendEmail(TARGET, "p", "m", exec)).toEqual({ ok: false, error: "curl failed" });
  });

  test("rejects a password containing control characters before touching disk", async () => {
    let called = false;
    const before = readdirSync(tmpdir()).filter((d) => d.startsWith("asl-email-"));
    const r = await sendEmail(TARGET, "bad\npass", "m", async () => {
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
  test("missing password returns the provisioning hint without invoking exec", async () => {
    let called = false;
    const r = await sendReportEmail(EMAIL_CFG, "subj", "text", "<p>html</p>", {
      env: {}, keychain: noKeychain, now: NOW,
      exec: async () => { called = true; return { ok: true, stdout: "", stderr: "" }; },
    });
    expect(called).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("security add-generic-password -s gmail-app-password -a asl");
  });

  test("sends a mime message containing subject and both parts", async () => {
    let eml = "";
    const r = await sendReportEmail(EMAIL_CFG, "ASL 2026-07-13: 1 blocked", "text body", "<p>html body</p>", {
      env: { ASL_SMTP_PASSWORD: "p" }, keychain: noKeychain, now: NOW,
      exec: async (argv) => {
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

  test("with an attachment, sends a multipart/mixed message carrying the attachment content", async () => {
    let eml = "";
    const r = await sendReportEmail(
      EMAIL_CFG, "ASL 2026-07-13: 1 blocked", "text body", "<p>digest body</p>",
      {
        env: { ASL_SMTP_PASSWORD: "p" }, keychain: noKeychain, now: NOW,
        exec: async (argv) => {
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

  test("send failure surfaces the curl error in the message", async () => {
    const r = await sendReportEmail(EMAIL_CFG, "s", "t", "h", {
      env: { ASL_SMTP_PASSWORD: "p" }, keychain: noKeychain, now: NOW,
      exec: async () => ({ ok: false, stdout: "", stderr: "curl: (67) Login denied" }),
    });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Login denied");
  });

  test("an exec that throws never escapes — returns ok:false with the message", async () => {
    const r = await sendReportEmail(EMAIL_CFG, "s", "t", "h", {
      env: { ASL_SMTP_PASSWORD: "p" }, keychain: noKeychain, now: NOW,
      exec: () => {
        throw new Error("spawn exploded");
      },
    });
    expect(r).toEqual({ ok: false, message: "email: spawn exploded" });
  });

  test("an unprintable throwable (String() itself throws) still never escapes", async () => {
    // Object.create(null) has no toString/valueOf, so String(e) throws
    // "Cannot convert object to primitive value" — the catch's formatter
    // must survive even that.
    const r = await sendReportEmail(EMAIL_CFG, "s", "t", "h", {
      env: {}, now: NOW,
      keychain: () => {
        throw Object.create(null);
      },
      exec: async () => ({ ok: true, stdout: "", stderr: "" }),
    });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("unprintable error");
  });
});

