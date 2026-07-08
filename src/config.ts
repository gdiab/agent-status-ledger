import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import type { Thresholds } from "./types";

export interface ConnectorConfig { enabled: boolean; rootDir: string; }

export interface Config {
  reportsDir: string;
  model: string;
  thresholds: Thresholds;
  connectors: { claudeCode: ConnectorConfig; codex: ConnectorConfig };
  redactPatterns: string[];   // extra user regexes (source strings)
}

export function defaultConfig(): Config {
  return {
    reportsDir: join(process.cwd(), "reports"),
    model: "claude-haiku-4-5-20251001",
    thresholds: { activeWindowHours: 2, silentThresholdHours: 6 },
    connectors: {
      claudeCode: { enabled: true, rootDir: join(homedir(), ".claude", "projects") },
      codex: { enabled: true, rootDir: join(homedir(), ".codex") },
    },
    redactPatterns: [],
  };
}

export function configPath(): string {
  return join(homedir(), ".config", "asl", "config.toml");
}

export function loadConfig(path: string = configPath()): Config {
  const c = defaultConfig();
  if (!existsSync(path)) return c;
  let raw: Record<string, unknown>;
  try {
    raw = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (e) {
    console.error(`warning: could not parse ${path}: ${e}; using defaults`);
    return c;
  }
  if (typeof raw.reports_dir === "string") c.reportsDir = raw.reports_dir;
  if (typeof raw.model === "string") c.model = raw.model;
  const t = raw.thresholds as Record<string, unknown> | undefined;
  if (typeof t?.active_window_hours === "number") c.thresholds.activeWindowHours = t.active_window_hours;
  if (typeof t?.silent_threshold_hours === "number") c.thresholds.silentThresholdHours = t.silent_threshold_hours;
  const conns = raw.connectors as Record<string, Record<string, unknown>> | undefined;
  for (const [key, target] of [["claude_code", c.connectors.claudeCode], ["codex", c.connectors.codex]] as const) {
    const section = conns?.[key];
    if (typeof section?.enabled === "boolean") target.enabled = section.enabled;
    if (typeof section?.root_dir === "string") target.rootDir = section.root_dir;
  }
  if (Array.isArray(raw.redact_patterns)) {
    c.redactPatterns = raw.redact_patterns.filter((p): p is string => typeof p === "string");
  }
  return c;
}
