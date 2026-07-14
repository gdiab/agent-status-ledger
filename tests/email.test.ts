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
