import { test, expect } from "bun:test";
import { resolveApiKey, type KeychainLookup } from "../src/apikey";

const noKeychain: KeychainLookup = () => null;

function fakeKeychain(entries: Record<string, string>): KeychainLookup {
  return (service, account) => entries[`${service}/${account ?? ""}`] ?? null;
}

test("prefers ASL_ANTHROPIC_API_KEY over everything else", () => {
  const result = resolveApiKey(
    { ASL_ANTHROPIC_API_KEY: "sk-asl", ANTHROPIC_API_KEY: "sk-generic" },
    fakeKeychain({ "anthropic-api-key/asl": "sk-keychain" }),
  );
  expect(result).toEqual({ key: "sk-asl", source: "ASL_ANTHROPIC_API_KEY env var" });
});

test("falls back to ANTHROPIC_API_KEY env var", () => {
  const result = resolveApiKey(
    { ANTHROPIC_API_KEY: "sk-generic" },
    fakeKeychain({ "anthropic-api-key/asl": "sk-keychain" }),
  );
  expect(result).toEqual({ key: "sk-generic", source: "ANTHROPIC_API_KEY env var" });
});

test("falls back to keychain asl account when env is empty", () => {
  const result = resolveApiKey({}, fakeKeychain({ "anthropic-api-key/asl": "sk-keychain" }));
  expect(result).toEqual({ key: "sk-keychain", source: "keychain anthropic-api-key (account: asl)" });
});

test("falls back to keychain generic entry last", () => {
  const result = resolveApiKey({}, fakeKeychain({ "anthropic-api-key/": "sk-any" }));
  expect(result).toEqual({ key: "sk-any", source: "keychain anthropic-api-key (any account)" });
});

test("returns null when no source has a key", () => {
  expect(resolveApiKey({}, noKeychain)).toBeNull();
});

test("treats empty-string env vars as unset", () => {
  const result = resolveApiKey(
    { ASL_ANTHROPIC_API_KEY: "", ANTHROPIC_API_KEY: "" },
    fakeKeychain({ "anthropic-api-key/asl": "sk-keychain" }),
  );
  expect(result?.key).toBe("sk-keychain");
});

test("does not touch the keychain when an env var provides the key", () => {
  let calls = 0;
  const countingKeychain: KeychainLookup = () => {
    calls++;
    return null;
  };
  resolveApiKey({ ANTHROPIC_API_KEY: "sk-generic" }, countingKeychain);
  expect(calls).toBe(0);
});

test("ignores whitespace-only keychain values", () => {
  const result = resolveApiKey({}, fakeKeychain({ "anthropic-api-key/asl": "  \n" }));
  expect(result).toBeNull();
});
