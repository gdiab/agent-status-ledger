import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import type { Thresholds } from "./types";

export interface ConnectorConfig { enabled: boolean; rootDir: string; }

// Engram (github.com/clickety-clacks/engram) is an optional fail-soft
// enrichment connector, not a log source — it has a binary path instead of a
// rootDir, and defaults to disabled until proven in real use (see
// src/connectors/engram). beadPrefixes are the issue-tracker prefixes
// task-key discovery may extract from dialogue (e.g. ["asl"] accepts
// asl-1wm); empty = bead-key threading off. An allowlist, not a shape guess:
// live validation showed a generic bead-shaped pattern drowns in hyphenated
// English ("apt-get", "one-off") minted from shared prompt boilerplate —
// 10 of 11 threads were false. Same posture as `enabled` itself: dormant
// until the operator names their tracker.
export interface EngramConfig { enabled: boolean; binaryPath: string; beadPrefixes: string[]; }

// A usable bead prefix: short, lowercase, letter-first — composable into the
// task-key regex verbatim (no metacharacters possible). Anything else in the
// config list is dropped, fail-closed.
export const BEAD_PREFIX_SHAPE = /^[a-z][a-z0-9]{0,11}$/;

// No whitespace of any kind (space, tab, CR, LF) in either address part.
const EMAIL_ADDRESS_SHAPE = /^[^\s@]+@[^\s@]+$/;
const SMTP_HOST_SHAPE = /^[A-Za-z0-9.-]+$/;

export interface EmailConfig {
  to: string;
  from: string;
  smtpHost: string;
  smtpPort: number;
}

export interface Config {
  reportsDir: string;
  model: string;
  thresholds: Thresholds;
  connectors: { claudeCode: ConnectorConfig; codex: ConnectorConfig; engram: EngramConfig };
  email?: EmailConfig;   // absent = email delivery off
  redactPatterns: string[];   // extra user regexes (source strings)
}

export function defaultConfig(): Config {
  return {
    reportsDir: join(process.cwd(), "reports"),
    model: "claude-haiku-4-5-20251001",
    thresholds: { activeWindowHours: 2, silentThresholdHours: 6, minSessionSeconds: 60 },
    connectors: {
      claudeCode: { enabled: true, rootDir: join(homedir(), ".claude", "projects") },
      codex: { enabled: true, rootDir: join(homedir(), ".codex") },
      engram: { enabled: false, binaryPath: "engram", beadPrefixes: [] },
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
  if (typeof t?.min_session_seconds === "number") c.thresholds.minSessionSeconds = t.min_session_seconds;
  const conns = raw.connectors as Record<string, Record<string, unknown>> | undefined;
  for (const [key, target] of [["claude_code", c.connectors.claudeCode], ["codex", c.connectors.codex]] as const) {
    const section = conns?.[key];
    if (typeof section?.enabled === "boolean") target.enabled = section.enabled;
    if (typeof section?.root_dir === "string") target.rootDir = section.root_dir;
  }
  const engramSection = conns?.engram;
  if (typeof engramSection?.enabled === "boolean") c.connectors.engram.enabled = engramSection.enabled;
  if (typeof engramSection?.binary_path === "string") c.connectors.engram.binaryPath = engramSection.binary_path;
  if (Array.isArray(engramSection?.bead_prefixes)) {
    c.connectors.engram.beadPrefixes = engramSection.bead_prefixes.filter(
      (p): p is string => typeof p === "string" && BEAD_PREFIX_SHAPE.test(p),
    );
  }
  const em = raw.email as Record<string, unknown> | undefined;
  // TOML multiline strings can smuggle CR/LF (and other control chars) into
  // values that later land in RFC 5322 headers or a curl.cfg directive line
  // — reject any whitespace in the address local/domain parts and restrict
  // smtp_host to a plain hostname shape rather than trying to blocklist bytes.
  if (typeof em?.to === "string" && em.to.trim() && EMAIL_ADDRESS_SHAPE.test(em.to)) {
    const from = typeof em.from === "string" && em.from.trim() && EMAIL_ADDRESS_SHAPE.test(em.from) ? em.from : em.to;
    const smtpHost = typeof em.smtp_host === "string" && SMTP_HOST_SHAPE.test(em.smtp_host)
      ? em.smtp_host
      : "smtp.gmail.com";
    c.email = {
      to: em.to,
      from,
      smtpHost,
      smtpPort: typeof em.smtp_port === "number" ? em.smtp_port : 465,
    };
  }
  if (Array.isArray(raw.redact_patterns)) {
    c.redactPatterns = raw.redact_patterns.filter((p): p is string => typeof p === "string");
  }
  return c;
}
