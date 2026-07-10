import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, RawSession, ScanOptions } from "../types";
import { firstLine, jsonlEntries, scanSessionFile } from "./jsonl";
import { toUtcIso } from "../time";

export function decodeProjectDir(name: string): string {
  // "-work-demo" → "/work/demo". Lossy for path segments containing dashes;
  // cwd fields inside entries take precedence when present.
  return name.replace(/-/g, "/");
}

export function parseClaudeSession(text: string, fallbackCwd: string, path?: string): RawSession | null {
  let cwd = fallbackCwd;
  let sessionId = "";
  let title: string | undefined;
  let startedAt: string | undefined;
  let lastEventAt: string | undefined;
  let endedOnError = false;
  let lastErrorLine = "";
  let awaitingUser = false;
  const events: AgentEvent[] = [];
  const filesTouched = new Set<string>();
  const errors: string[] = [];

  for (const entry of jsonlEntries(text, path)) {
    if (typeof entry.sessionId === "string") sessionId = entry.sessionId;
    if (typeof entry.cwd === "string") cwd = entry.cwd;
    const ts = typeof entry.timestamp === "string" ? toUtcIso(entry.timestamp) : undefined;
    if (ts) {
      if (!startedAt || ts < startedAt) startedAt = ts;
      if (!lastEventAt || ts > lastEventAt) lastEventAt = ts;
    }
    switch (entry.type) {
      case "ai-title":
        if (typeof entry.title === "string") title = entry.title;
        break;
      case "file-history-snapshot": {
        const backups = entry.snapshot?.trackedFileBackups;
        if (backups && typeof backups === "object") {
          for (const f of Object.keys(backups)) filesTouched.add(f);
        }
        break;
      }
      case "user":
      case "assistant": {
        if (!ts) break;
        events.push({ timestamp: ts, type: "run_progressed", summary: `${entry.type} turn` });
        endedOnError = false;
        const content = entry.message?.content;
        if (Array.isArray(content)) {
          for (const item of content) {
            if (item?.type === "tool_result" && item.is_error === true) {
              const body = typeof item.content === "string" ? item.content : JSON.stringify(item.content ?? "");
              lastErrorLine = firstLine(body);
              errors.push(lastErrorLine);
              endedOnError = true;
            }
          }
        }
        // Ball-in-court: only an assistant reply with no tool_use pending means
        // the human owes the next move. A trailing user entry (real message or
        // tool_result) leaves the agent on the hook.
        awaitingUser = entry.type === "assistant" &&
          !(Array.isArray(content) && content.some((i: any) => i?.type === "tool_use"));
        break;
      }
      default:
        break;
    }
  }

  if (!startedAt || !lastEventAt || events.length === 0) return null;
  const all: AgentEvent[] = [
    { timestamp: startedAt, type: "run_started", summary: "session started" },
    ...events,
  ];
  if (endedOnError) {
    all.push({ timestamp: lastEventAt, type: "failed", summary: lastErrorLine });
  }
  return {
    platform: "claude-code",
    sessionId: sessionId || "unknown",
    cwd,
    startedAt,
    lastEventAt,
    title,
    events: all,
    filesTouched: [...filesTouched].sort(),
    errors,
    awaitingUser,
  };
}

export async function scanClaudeCode(opts: ScanOptions): Promise<RawSession[]> {
  const out: RawSession[] = [];
  if (!existsSync(opts.rootDir)) return out;
  for (const dir of readdirSync(opts.rootDir)) {
    const projDir = join(opts.rootDir, dir);
    let entries: string[];
    try {
      if (!statSync(projDir).isDirectory()) continue;
      entries = readdirSync(projDir);
    } catch {
      continue;
    }
    for (const file of entries) {
      if (!file.endsWith(".jsonl")) continue;
      const path = join(projDir, file);
      const session = scanSessionFile(path, opts, (text) => parseClaudeSession(text, decodeProjectDir(dir), path));
      if (session) out.push(session);
    }
  }
  return out;
}
