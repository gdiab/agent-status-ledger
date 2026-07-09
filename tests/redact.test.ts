import { describe, expect, test } from "bun:test";
import { redact, redactFacts } from "../src/redact";

describe("redact", () => {
  test("masks common credential shapes", () => {
    const cases = [
      "key sk-ant-api03-abcdefghijklmnop1234 here",
      "token ghp_ABCDEFGHIJKLMNOPQRST123456 done",
      "slack xoxb-123456789012-abcdefghijklm end",
      "aws AKIAIOSFODNN7EXAMPLE region",
      "jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c ok",
      "api_key = \"supersecretvalue123\"",
      "auth Authorization: Bearer abcdefghijklmnop.qrstuvwx-yz123456 end",
    ];
    for (const c of cases) {
      const r = redact(c);
      expect(r).toContain("[REDACTED]");
      expect(r).not.toContain("supersecretvalue123");
    }
    expect(redact("plain text, no secrets")).toBe("plain text, no secrets");
  });

  test("private key blocks are masked", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----";
    expect(redact(pem)).toBe("[REDACTED]");
  });

  test("redacted JSON stays parseable", () => {
    const out = redact('{"blocked":"login failed, password=hunter2secret"}');
    expect(() => JSON.parse(out)).not.toThrow();
    expect(out).toContain("[REDACTED]");
  });

  test("masks uppercase key prefixes", () => {
    const cases = [
      "key SK-ANT-API03-ABCDEFGHIJKLMNOP1234 here",
      "token GHP_ABCDEFGHIJKLMNOPQRST123456 done",
      "slack XOXB-123456789012-ABCDEFGHIJKLM end",
    ];
    for (const c of cases) {
      const r = redact(c);
      expect(r).toContain("[REDACTED]");
      expect(r).not.toMatch(/ABCDEFGHIJKLM/);
    }
  });

  test("masks short generic values", () => {
    const r = redact("login failed, password=hunter2");
    expect(r).toContain("[REDACTED]");
    expect(r).not.toContain("hunter2");
  });

  test("masks quoted multiline values, preserving key and quotes", () => {
    expect(redact('api_key = "line one\nline two extra"')).toBe('api_key = "[REDACTED]"');
    expect(redact("secret: 'abc\ndef'")).toBe("secret: '[REDACTED]'");
  });

  test("quoted single-line values keep surrounding JSON parseable", () => {
    const out = redact('{"password":"hunter2secret","next":"ok"}');
    expect(() => JSON.parse(out)).not.toThrow();
    expect(out).not.toContain("hunter2secret");
    expect(out).toContain('"next":"ok"');
  });

  test("extra user patterns apply", () => {
    expect(redact("internal-code-XJ99", ["internal-code-\\w+"])).toBe("[REDACTED]");
  });

  test("redactFacts covers every string field", () => {
    const f = redactFacts({
      titles: ["Deploy with ghp_ABCDEFGHIJKLMNOPQRST123456"],
      filesTouched: ["/w/a.ts"],
      errors: ["Error: bad key sk-ant-api03-abcdefghijklmnop1234"],
      commits: ["abc1234 add feature"],
      sessionCount: 1,
      firstActivity: "2026-07-07T09:00:00.000Z",
      lastActivity: "2026-07-07T10:00:00.000Z",
    });
    expect(f.titles[0]).toContain("[REDACTED]");
    expect(f.errors[0]).toContain("[REDACTED]");
    expect(f.commits[0]).toBe("abc1234 add feature");
  });
});
