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
