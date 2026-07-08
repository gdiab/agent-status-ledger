import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, RawSession, ScanOptions } from "../types";

export function decodeProjectDir(name: string): string {
  // "-work-demo" → "/work/demo". Lossy for path segments containing dashes;
  // cwd fields inside entries take precedence when present.
  return name.replace(/-/g, "/");
}

function firstLine(s: string): string {
  return s.split("\n", 1)[0]!.slice(0, 200);
}

export function parseClaudeSession(text: string, fallbackCwd: string): RawSession | null {
  let cwd = fallbackCwd;
  let sessionId = "";
  let title: string | undefined;
  let startedAt: string | undefined;
  let lastEventAt: string | undefined;
  let endedOnError = false;
  let lastErrorLine = "";
  const events: AgentEvent[] = [];
  const filesTouched = new Set<string>();
  const errors: string[] = [];

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // unknown/broken lines ignored by design
    }
    if (typeof entry.sessionId === "string") sessionId = entry.sessionId;
    if (typeof entry.cwd === "string") cwd = entry.cwd;
    const ts = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
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
      try {
        const stat = statSync(path);
        if (stat.mtime < opts.since || stat.mtime > opts.now) continue;
        const session = parseClaudeSession(readFileSync(path, "utf8"), decodeProjectDir(dir));
        if (session) out.push(session);
      } catch (e) {
        console.error(`warning: skipping ${path}: ${e}`);
      }
    }
  }
  return out;
}
