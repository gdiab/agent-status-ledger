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

export function resolveApiKey(
  env: Record<string, string | undefined>,
  keychain: KeychainLookup,
): ResolvedKey | null {
  const candidates: Array<[() => string | null | undefined, string]> = [
    [() => env.ASL_ANTHROPIC_API_KEY, "ASL_ANTHROPIC_API_KEY env var"],
    [() => env.ANTHROPIC_API_KEY, "ANTHROPIC_API_KEY env var"],
    [() => keychain(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT), `keychain ${KEYCHAIN_SERVICE} (account: ${KEYCHAIN_ACCOUNT})`],
    [() => keychain(KEYCHAIN_SERVICE), `keychain ${KEYCHAIN_SERVICE} (any account)`],
  ];
  for (const [get, source] of candidates) {
    const key = get()?.trim();
    if (key) return { key, source };
  }
  return null;
}

// Real lookup via the macOS `security` CLI. Returns null off-macOS, when the
// entry is missing, or when the user denies the keychain prompt.
export const macKeychainLookup: KeychainLookup = (service, account) => {
  if (process.platform !== "darwin") return null;
  const args = ["security", "find-generic-password", "-s", service, "-w"];
  if (account) args.splice(4, 0, "-a", account);
  const proc = Bun.spawnSync(args, { stderr: "ignore" });
  if (proc.exitCode !== 0) return null;
  return proc.stdout.toString();
};
