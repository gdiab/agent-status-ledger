import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, RawSession, ScanOptions } from "../types";
import { firstLine, jsonlEntries, scanSessionFile, withContext } from "./jsonl";
import { redact } from "../redact";
import { toUtcIso } from "../time";

export function decodeProjectDir(name: string): string {
  // "-work-demo" → "/work/demo". Lossy for path segments containing dashes;
  // cwd fields inside entries take precedence when present.
  return name.replace(/-/g, "/");
}

export function parseClaudeSession(text: string, fallbackCwd: string, path?: string, redactPatterns: string[] = []): RawSession | null {
  let cwd = fallbackCwd;
  let sessionId = "";
  let title: string | undefined;
  let startedAt: string | undefined;
  let lastEventAt: string | undefined;
  let endedOnError = false;
  let lastErrorLine = "";
  let awaitingUser = false;
  let midWork = false;
  const events: AgentEvent[] = [];
  const filesTouched = new Set<string>();
  const errors: string[] = [];
  const toolUses = new Map<string, { name: string; input: unknown }>();

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
        // Flag updates need only entry.type/content, not a timestamp — a
        // trailing entry with no timestamp must still update the ball-in-court
        // and mid-work reads for the session, even though it contributes no
        // event of its own. tool_use map registration is likewise needed
        // before any later tool_result (timestamped or not) resolves it.
        const content = entry.message?.content;
        if (Array.isArray(content)) {
          for (const item of content) {
            if (item?.type === "tool_use" && typeof item.id === "string") {
              toolUses.set(item.id, { name: String(item.name ?? "tool"), input: item.input });
            }
          }
        }
        // Ball-in-court: only an assistant reply with no tool_use pending means
        // the human owes the next move. A trailing user entry (real message or
        // tool_result) leaves the agent on the hook.
        awaitingUser = entry.type === "assistant" &&
          !(Array.isArray(content) && content.some((i: any) => i?.type === "tool_use"));
        // Mid-work: an assistant turn that fires a tool call, or a user turn
        // that delivers a tool_result still awaiting the agent's processing,
        // both mean work is visibly in flight. A plain message (either side)
        // clears it.
        midWork = Array.isArray(content) &&
          content.some((i: any) => i?.type === (entry.type === "assistant" ? "tool_use" : "tool_result"));

        if (!ts) break;
        events.push({ timestamp: ts, type: "run_progressed", summary: `${entry.type} turn` });
        endedOnError = false;
        if (Array.isArray(content)) {
          for (const item of content) {
            if (item?.type === "tool_result" && item.is_error === true) {
              // Redact before firstLine's 200-char slice — same straddle hazard
              // as withContext's 80-char context slice.
              const body = redact(typeof item.content === "string" ? item.content : JSON.stringify(item.content ?? ""), redactPatterns);
              const tool = typeof item.tool_use_id === "string" ? toolUses.get(item.tool_use_id) : undefined;
              lastErrorLine = tool ? withContext(firstLine(body), tool.name, tool.input, redactPatterns) : firstLine(body);
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
    awaitingUser,
    midWork,
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
      const session = scanSessionFile(path, opts, (text) => parseClaudeSession(text, decodeProjectDir(dir), path, opts.redactPatterns));
      if (session) out.push(session);
    }
  }
  return out;
}
