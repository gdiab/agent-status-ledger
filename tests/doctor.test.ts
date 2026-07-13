import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkApiKey,
  checkBun,
  checkConfigFile,
  checkConnectorDir,
  checkLaunchdBunPath,
  checkPlistInstalled,
  checkPlistLoaded,
  formatDoctorReport,
  runDoctor,
  type DoctorDeps,
  type Exec,
} from "../src/doctor";
import type { KeychainLookup } from "../src/apikey";

const execOk =
  (stdout: string): Exec =>
  () => ({ ok: true, stdout });
const execFail: Exec = () => ({ ok: false, stdout: "" });
const noKeychain: KeychainLookup = () => null;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "asl-doctor-"));
}

describe("checkBun", () => {
  test("passes with version in detail", () => {
    const r = checkBun(execOk("1.2.3"));
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("1.2.3");
    expect(r.fix).toBeUndefined();
  });

  test("fails with install hint when bun is missing", () => {
    const r = checkBun(execFail);
    expect(r.ok).toBe(false);
    expect(r.fix).toContain("bun.sh");
  });
});

describe("checkLaunchdBunPath", () => {
  test("passes when the launchd bun binary exists", () => {
    const dir = tempDir();
    const bunPath = join(dir, "bun");
    writeFileSync(bunPath, "");
    expect(checkLaunchdBunPath(bunPath).ok).toBe(true);
  });

  test("fails with a symlink fix when missing", () => {
    const r = checkLaunchdBunPath(join(tempDir(), "nope", "bun"));
    expect(r.ok).toBe(false);
    expect(r.fix).toContain("ln -s");
  });
});

describe("checkApiKey", () => {
  test("passes when resolver finds a key, reporting the source", () => {
    const r = checkApiKey({ ANTHROPIC_API_KEY: "sk-x" }, noKeychain);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("ANTHROPIC_API_KEY env var");
  });

  test("passes via keychain using the resolver's own service/account", () => {
    const keychain: KeychainLookup = (service, account) =>
      service === "anthropic-api-key" && account === "asl" ? "sk-k" : null;
    const r = checkApiKey({}, keychain);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("keychain");
  });

  test("fails with the exact security add-generic-password form", () => {
    const r = checkApiKey({}, noKeychain);
    expect(r.ok).toBe(false);
    expect(r.fix).toContain("security add-generic-password -s anthropic-api-key -a asl -w");
  });
});

describe("checkPlistInstalled", () => {
  test("passes when the plist file exists", () => {
    const dir = tempDir();
    const plist = join(dir, "com.gd.asl-report.plist");
    writeFileSync(plist, "<plist/>");
    expect(checkPlistInstalled(plist).ok).toBe(true);
  });

  test("fails with a load hint when missing", () => {
    const r = checkPlistInstalled(join(tempDir(), "com.gd.asl-report.plist"));
    expect(r.ok).toBe(false);
    expect(r.fix).toContain("launchctl load");
  });
});

describe("checkPlistLoaded", () => {
  test("passes when launchctl lists the label", () => {
    const r = checkPlistLoaded(execOk('{ "Label" = "com.gd.asl-report"; }'), "/x.plist");
    expect(r.ok).toBe(true);
  });

  test("fails with launchctl load fix when not loaded", () => {
    const r = checkPlistLoaded(execFail, "/x.plist");
    expect(r.ok).toBe(false);
    expect(r.fix).toBe("launchctl load -w /x.plist");
  });
});

describe("checkConnectorDir", () => {
  test("passes for an existing readable directory", () => {
    const dir = tempDir();
    const r = checkConnectorDir("claude-code", { enabled: true, rootDir: dir });
    expect(r.ok).toBe(true);
    expect(r.detail).toContain(dir);
  });

  test("fails for a missing directory with a hint", () => {
    const r = checkConnectorDir("codex", { enabled: true, rootDir: join(tempDir(), "gone") });
    expect(r.ok).toBe(false);
    expect(r.fix).toContain("root_dir");
  });

  test("a disabled connector passes as skipped", () => {
    const r = checkConnectorDir("codex", { enabled: false, rootDir: "/nope" });
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("disabled");
  });
});

describe("checkConfigFile", () => {
  test("missing config file is fine (defaults in use)", () => {
    const r = checkConfigFile(join(tempDir(), "config.toml"));
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("defaults");
  });

  test("valid toml passes", () => {
    const p = join(tempDir(), "config.toml");
    writeFileSync(p, 'model = "claude-haiku-4-5-20251001"\n');
    expect(checkConfigFile(p).ok).toBe(true);
  });

  test("broken toml fails with the parse error and file path", () => {
    const p = join(tempDir(), "config.toml");
    writeFileSync(p, "reports_dir = [unclosed\n");
    const r = checkConfigFile(p);
    expect(r.ok).toBe(false);
    expect(r.fix).toContain(p);
  });
});

function fakeDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  const home = tempDir();
  return {
    env: {},
    keychain: noKeychain,
    exec: execFail,
    platform: "darwin",
    home,
    configPath: join(home, "config.toml"),
    ...overrides,
  };
}

describe("runDoctor", () => {
  test("never throws even when everything is missing, and reports all checks", () => {
    const results = runDoctor(fakeDeps());
    expect(results.length).toBe(8);
    for (const r of results) {
      expect(typeof r.name).toBe("string");
      expect(typeof r.detail).toBe("string");
      if (!r.ok) expect(r.fix).toBeTruthy();
    }
  });

  test("all green on a fully set-up fake machine", () => {
    const home = tempDir();
    mkdirSync(join(home, ".bun", "bin"), { recursive: true });
    writeFileSync(join(home, ".bun", "bin", "bun"), "");
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(join(home, "Library", "LaunchAgents", "com.gd.asl-report.plist"), "<plist/>");
    mkdirSync(join(home, ".claude", "projects"), { recursive: true });
    mkdirSync(join(home, ".codex"), { recursive: true });
    const configPath = join(home, "config.toml");
    writeFileSync(
      configPath,
      [
        "[connectors.claude_code]",
        `root_dir = "${join(home, ".claude", "projects")}"`,
        "[connectors.codex]",
        `root_dir = "${join(home, ".codex")}"`,
      ].join("\n"),
    );
    const results = runDoctor(
      fakeDeps({
        home,
        configPath,
        env: { ANTHROPIC_API_KEY: "sk-x" },
        exec: execOk("1.2.3"),
      }),
    );
    expect(results.every((r) => r.ok)).toBe(true);
  });

  test("launchd checks are skipped off macOS", () => {
    const results = runDoctor(fakeDeps({ platform: "linux" }));
    const launchd = results.filter((r) => r.name.includes("launchd"));
    expect(launchd.length).toBeGreaterThan(0);
    for (const r of launchd) {
      expect(r.ok).toBe(true);
      expect(r.detail).toContain("skipped");
    }
  });
});

describe("formatDoctorReport", () => {
  test("shows pass/fail markers, fixes, and a summary line", () => {
    const out = formatDoctorReport([
      { name: "bun", ok: true, detail: "1.2.3" },
      { name: "keychain API key", ok: false, detail: "not found", fix: "security add-generic-password ..." },
    ]);
    expect(out).toContain("ok");
    expect(out).toContain("FAIL");
    expect(out).toContain("fix: security add-generic-password ...");
    expect(out).toContain("1/2 checks passed");
  });
});
