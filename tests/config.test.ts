import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, loadConfig } from "../src/config";

describe("config", () => {
  test("defaults are sane when no file exists", () => {
    const c = loadConfig(join(tmpdir(), "does-not-exist.toml"));
    expect(c.thresholds.activeWindowHours).toBe(2);
    expect(c.thresholds.silentThresholdHours).toBe(6);
    expect(c.model).toBe("claude-haiku-4-5-20251001");
    expect(c.connectors.claudeCode.enabled).toBe(true);
    expect(c.connectors.codex.enabled).toBe(true);
    expect(c.reportsDir.endsWith("reports")).toBe(true);
  });

  test("toml file overrides defaults, unknown keys ignored", () => {
    const dir = mkdtempSync(join(tmpdir(), "asl-config-"));
    const p = join(dir, "config.toml");
    writeFileSync(p, [
      "reports_dir = \"/tmp/x\"",
      "model = \"claude-sonnet-5\"",
      "mystery = true",
      "[thresholds]",
      "silent_threshold_hours = 12",
      "[connectors.codex]",
      "enabled = false",
    ].join("\n"));
    const c = loadConfig(p);
    expect(c.reportsDir).toBe("/tmp/x");
    expect(c.model).toBe("claude-sonnet-5");
    expect(c.thresholds.silentThresholdHours).toBe(12);
    expect(c.thresholds.activeWindowHours).toBe(2); // untouched default
    expect(c.connectors.codex.enabled).toBe(false);
    expect(c.connectors.claudeCode.enabled).toBe(true);
  });

  test("defaultConfig points connectors at the real homes", () => {
    const c = defaultConfig();
    expect(c.connectors.claudeCode.rootDir).toContain(".claude/projects");
    expect(c.connectors.codex.rootDir).toContain(".codex");
  });

  test("minSessionSeconds defaults to 60", () => {
    expect(defaultConfig().thresholds.minSessionSeconds).toBe(60);
  });

  test("thresholds.min_session_seconds is read from toml", () => {
    const dir = mkdtempSync(join(tmpdir(), "asl-config-"));
    const p = join(dir, "config.toml");
    writeFileSync(p, "[thresholds]\nmin_session_seconds = 120\n");
    expect(loadConfig(p).thresholds.minSessionSeconds).toBe(120);
  });
});

function writeToml(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "asl-config-"));
  const p = join(dir, "config.toml");
  writeFileSync(p, content);
  return p;
}

describe("email config", () => {
  test("absent [email] section leaves email unset", () => {
    const path = writeToml(`reports_dir = "/tmp/r"\n`);
    expect(loadConfig(path).email).toBeUndefined();
  });

  test("minimal [email] with to applies defaults", () => {
    const path = writeToml(`[email]\nto = "gd@example.com"\n`);
    expect(loadConfig(path).email).toEqual({
      to: "gd@example.com",
      from: "gd@example.com",
      smtpHost: "smtp.gmail.com",
      smtpPort: 465,
    });
  });

  test("full [email] section overrides all defaults", () => {
    const path = writeToml(
      `[email]\nto = "a@x.com"\nfrom = "b@y.com"\nsmtp_host = "smtp.other.com"\nsmtp_port = 587\n`,
    );
    expect(loadConfig(path).email).toEqual({
      to: "a@x.com", from: "b@y.com", smtpHost: "smtp.other.com", smtpPort: 587,
    });
  });

  test("[email] without a usable to stays disabled", () => {
    expect(loadConfig(writeToml(`[email]\nfrom = "b@y.com"\n`)).email).toBeUndefined();
    expect(loadConfig(writeToml(`[email]\nto = 42\n`)).email).toBeUndefined();
    expect(loadConfig(writeToml(`[email]\nto = "  "\n`)).email).toBeUndefined();
  });

  test("wrong-typed optional email fields fall back to defaults", () => {
    const path = writeToml(`[email]\nto = "a@x.com"\nsmtp_port = "not-a-number"\nfrom = 7\n`);
    expect(loadConfig(path).email).toEqual({
      to: "a@x.com", from: "a@x.com", smtpHost: "smtp.gmail.com", smtpPort: 465,
    });
  });
});
