// Resolves the Anthropic API key. Keychain convention: one service name
// ("anthropic-api-key") shared by all projects, account = project name, so
// per-project keys stay separable for usage tracking.
export type KeychainLookup = (service: string, account?: string) => string | null;

export interface ResolvedKey {
  key: string;
  source: string;
}

export const KEYCHAIN_SERVICE = "anthropic-api-key";
export const KEYCHAIN_ACCOUNT = "asl";

// Shared by every secret lookup (API key here, SMTP password in email.ts):
// try each candidate in order, first non-blank trimmed value wins.
export function resolveSecret(
  candidates: Array<[() => string | null | undefined, string]>,
): { value: string; source: string } | null {
  for (const [get, source] of candidates) {
    const value = get()?.trim();
    if (value) return { value, source };
  }
  return null;
}

export function resolveApiKey(
  env: Record<string, string | undefined>,
  keychain: KeychainLookup,
): ResolvedKey | null {
  const resolved = resolveSecret([
    [() => env.ASL_ANTHROPIC_API_KEY, "ASL_ANTHROPIC_API_KEY env var"],
    [() => env.ANTHROPIC_API_KEY, "ANTHROPIC_API_KEY env var"],
    [() => keychain(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT), `keychain ${KEYCHAIN_SERVICE} (account: ${KEYCHAIN_ACCOUNT})`],
    [() => keychain(KEYCHAIN_SERVICE), `keychain ${KEYCHAIN_SERVICE} (any account)`],
  ]);
  return resolved ? { key: resolved.value, source: resolved.source } : null;
}

// Real lookup via the macOS `security` CLI. Returns null off-macOS, when the
// entry is missing, or when the user denies the keychain prompt.
// Deliberately stays on Bun.spawnSync (unlike the async Exec seam in
// src/exec.ts, asl-e2q): keychain lookups happen once at CLI startup and
// once before an email send — serial one-shot probes outside buildReport's
// concurrent region, with nothing in flight for a blocking call to stall —
// and a KeychainLookup is a distinct, simpler seam (string|null) that many
// pure check functions consume synchronously.
export const macKeychainLookup: KeychainLookup = (service, account) => {
  if (process.platform !== "darwin") return null;
  const args = ["security", "find-generic-password", "-s", service, "-w"];
  if (account) args.splice(4, 0, "-a", account);
  // A keychain prompt with no user present (the unattended launchd run) would
  // otherwise hang forever; bound it so a stuck prompt degrades to a null
  // lookup (non-zero/absent exit code) instead of blocking the whole report.
  // Shared with the SMTP password lookup in email.ts — neither may hang.
  const proc = Bun.spawnSync(args, { stderr: "ignore", timeout: 60_000 });
  if (proc.exitCode !== 0) return null;
  return proc.stdout.toString();
};
