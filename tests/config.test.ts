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
