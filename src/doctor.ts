// `asl doctor` — setup checks. Every check is a pure function over injected
// deps and returns a result; a missing thing is a failed check with a fix
// hint, never a throw. Grounded in what the code actually uses:
//   - keychain service/account from src/apikey.ts
//   - config path/shape from src/config.ts
//   - connector roots from src/config.ts defaults (~/.claude/projects, ~/.codex)
//   - launchd label com.gd.asl-report from scripts/morning-report.sh, which
//     invokes bun at the absolute path $HOME/.bun/bin/bun.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE, resolveApiKey, type KeychainLookup } from "./apikey";
import { loadConfig, type ConnectorConfig } from "./config";

export const LAUNCHD_LABEL = "com.gd.asl-report";

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

export type Exec = (argv: string[]) => { ok: boolean; stdout: string };

export interface DoctorDeps {
  env: Record<string, string | undefined>;
  keychain: KeychainLookup;
  exec: Exec;
  platform: string;
  home: string;
  configPath: string;
}

export function checkBun(exec: Exec): CheckResult {
  const r = exec(["bun", "--version"]);
  return r.ok
    ? { name: "bun on PATH", ok: true, detail: `version ${r.stdout.trim()}` }
    : {
        name: "bun on PATH",
        ok: false,
        detail: "bun --version failed",
        fix: 'curl -fsSL https://bun.sh/install | bash',
      };
}

// morning-report.sh addresses bun absolutely because launchd provides no PATH.
export function checkLaunchdBunPath(bunPath: string): CheckResult {
  const name = "bun at launchd path";
  return existsSync(bunPath)
    ? { name, ok: true, detail: bunPath }
    : {
        name,
        ok: false,
        detail: `${bunPath} missing — the launchd job hardcodes this path`,
        fix: `mkdir -p "$(dirname ${bunPath})" && ln -s "$(which bun)" ${bunPath}`,
      };
}

export function checkApiKey(env: Record<string, string | undefined>, keychain: KeychainLookup): CheckResult {
  const name = "Anthropic API key";
  const resolved = resolveApiKey(env, keychain);
  return resolved
    ? { name, ok: true, detail: `found via ${resolved.source}` }
    : {
        name,
        ok: false,
        detail: "not found in env (ASL_ANTHROPIC_API_KEY, ANTHROPIC_API_KEY) or keychain",
        fix: `security add-generic-password -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -w "<your sk-ant-... key>"`,
      };
}

export function checkPlistInstalled(plistPath: string): CheckResult {
  const name = "launchd plist installed";
  return existsSync(plistPath)
    ? { name, ok: true, detail: plistPath }
    : {
        name,
        ok: false,
        detail: `${plistPath} not found`,
        fix: `create the ${LAUNCHD_LABEL} plist (see skills/asl-doctor/SKILL.md), then: launchctl load -w ${plistPath}`,
      };
}

export function checkPlistLoaded(exec: Exec, plistPath: string): CheckResult {
  const name = "launchd job loaded";
  const r = exec(["launchctl", "list", LAUNCHD_LABEL]);
  return r.ok
    ? { name, ok: true, detail: `${LAUNCHD_LABEL} is loaded` }
    : {
        name,
        ok: false,
        detail: `launchctl list ${LAUNCHD_LABEL} found nothing`,
        fix: `launchctl load -w ${plistPath}`,
      };
}

export function checkConnectorDir(label: string, conn: ConnectorConfig): CheckResult {
  const name = `${label} logs`;
  if (!conn.enabled) return { name, ok: true, detail: "disabled in config — skipped" };
  try {
    readdirSync(conn.rootDir); // exists AND readable
    return { name, ok: true, detail: conn.rootDir };
  } catch (e) {
    return {
      name,
      ok: false,
      detail: `${conn.rootDir} is missing or unreadable (${(e as NodeJS.ErrnoException)?.code ?? e})`,
      fix: `run ${label} at least once to create it, or point connectors.${label.replace(/-/g, "_")}.root_dir in ~/.config/asl/config.toml at the right place`,
    };
  }
}

export function checkConfigFile(configPath: string): CheckResult {
  const name = "config file";
  if (!existsSync(configPath)) {
    return { name, ok: true, detail: `${configPath} not present — defaults in use` };
  }
  try {
    parse(readFileSync(configPath, "utf8"));
    return { name, ok: true, detail: `${configPath} parses` };
  } catch (e) {
    return {
      name,
      ok: false,
      detail: `TOML parse error: ${e instanceof Error ? e.message.split("\n")[0] : e}`,
      fix: `fix the TOML syntax in ${configPath}`,
    };
  }
}

const skipped = (name: string): CheckResult => ({ name, ok: true, detail: "skipped — not macOS" });

export function runDoctor(deps: DoctorDeps): CheckResult[] {
  const mac = deps.platform === "darwin";
  const plistPath = join(deps.home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  const launchdBun = join(deps.home, ".bun", "bin", "bun");
  // loadConfig never throws (bad TOML falls back to defaults with a warning),
  // so connector checks always have a config; checkConfigFile reports the
  // parse problem itself.
  const config = loadConfig(deps.configPath);
  return [
    checkBun(deps.exec),
    mac ? checkLaunchdBunPath(launchdBun) : skipped("bun at launchd path"),
    checkApiKey(deps.env, deps.keychain),
    mac ? checkPlistInstalled(plistPath) : skipped("launchd plist installed"),
    mac ? checkPlistLoaded(deps.exec, plistPath) : skipped("launchd job loaded"),
    checkConfigFile(deps.configPath),
    checkConnectorDir("claude-code", config.connectors.claudeCode),
    checkConnectorDir("codex", config.connectors.codex),
  ];
}

export function formatDoctorReport(results: CheckResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    lines.push(`${r.ok ? "  ok " : " FAIL"} ${r.name} — ${r.detail}`);
    if (!r.ok && r.fix) lines.push(`      fix: ${r.fix}`);
  }
  const passed = results.filter((r) => r.ok).length;
  lines.push(`${passed}/${results.length} checks passed`);
  return lines.join("\n");
}
