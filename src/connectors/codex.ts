import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, RawSession, ScanOptions } from "../types";
import { firstLine, jsonlEntries, scanSessionFile } from "./jsonl";

export function parseCodexSession(text: string, titles: Map<string, string>): RawSession | null {
  let cwd = "";
  let sessionId = "";
  let startedAt: string | undefined;
  let lastEventAt: string | undefined;
  const events: AgentEvent[] = [];
  const errors: string[] = [];

  for (const entry of jsonlEntries(text)) {
    const ts = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
    if (ts) {
      if (!startedAt || ts < startedAt) startedAt = ts;
      if (!lastEventAt || ts > lastEventAt) lastEventAt = ts;
    }
    if (entry.type === "session_meta" && entry.payload) {
      if (typeof entry.payload.cwd === "string") cwd = entry.payload.cwd;
      const id = entry.payload.id ?? entry.payload.session_id;
      if (typeof id === "string") sessionId = id;
      continue;
    }
    if (entry.type === "event_msg" && entry.payload && ts) {
      const p = entry.payload;
      switch (p.type) {
        case "task_started":
        case "agent_message":
          events.push({ timestamp: ts, type: "run_progressed", summary: p.type });
          break;
        case "task_complete":
          events.push({ timestamp: ts, type: "completed", summary: firstLine(String(p.last_agent_message ?? "task complete")) });
          break;
        case "error":
        case "stream_error": {
          const msg = firstLine(String(p.message ?? "error"));
          errors.push(msg);
          events.push({ timestamp: ts, type: "failed", summary: msg });
          break;
        }
        case "exec_approval_request":
        case "apply_patch_approval_request":
          events.push({ timestamp: ts, type: "approval_requested", summary: `approval requested: ${firstLine(String(p.command ?? p.type))}` });
          break;
        default:
          break;
      }
    }
  }

  if (!sessionId || !startedAt || !lastEventAt) return null;
  return {
    platform: "codex",
    sessionId,
    cwd: cwd || "unknown",
    startedAt,
    lastEventAt,
    title: titles.get(sessionId),
    events: [{ timestamp: startedAt, type: "run_started", summary: "session started" }, ...events],
    filesTouched: [],
    errors,
  };
}

export function loadCodexTitles(rootDir: string): Map<string, string> {
  const titles = new Map<string, string>();
  const indexPath = join(rootDir, "session_index.jsonl");
  if (!existsSync(indexPath)) return titles;
  for (const e of jsonlEntries(readFileSync(indexPath, "utf8"))) {
    if (typeof e.id === "string" && typeof e.thread_name === "string") titles.set(e.id, e.thread_name);
  }
  return titles;
}

function* dateDirsInWindow(sessionsDir: string, since: Date, now: Date): Generator<string> {
  const day = new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate()));
  while (day.getTime() <= now.getTime()) {
    const y = String(day.getUTCFullYear());
    const m = String(day.getUTCMonth() + 1).padStart(2, "0");
    const d = String(day.getUTCDate()).padStart(2, "0");
    const dir = join(sessionsDir, y, m, d);
    if (existsSync(dir)) yield dir;
    day.setUTCDate(day.getUTCDate() + 1);
  }
}

export async function scanCodex(opts: ScanOptions): Promise<RawSession[]> {
  const out: RawSession[] = [];
  const sessionsDir = join(opts.rootDir, "sessions");
  if (!existsSync(sessionsDir)) return out;
  const titles = loadCodexTitles(opts.rootDir);
  for (const dir of dateDirsInWindow(sessionsDir, opts.since, opts.now)) {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".jsonl")) continue;
      const path = join(dir, file);
      const session = scanSessionFile(path, opts, (text) => parseCodexSession(text, titles));
      if (session) out.push(session);
    }
  }
  return out;
}
