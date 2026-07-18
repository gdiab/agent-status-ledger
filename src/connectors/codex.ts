import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, RawSession, ScanOptions } from "../types";
import { jsonlEntries, makeClip, scanSessionFile, withContext, type Clip } from "./jsonl";
import { toUtcIso } from "../time";

const TITLE_MAX = 80;

// Ambient UI blocks injected into user_message by the codex client (e.g.
// <in-app-browser-context source="ambient-ui-state">…</in-app-browser-context>).
// They are machine-supplied UI state, not the human's request — stripped
// before task-text extraction so ambient text never masquerades as the task.
// Two nets: any element self-declaring source="ambient-…", plus the known
// in-app-browser-context tag in case a client omits the attribute.
const AMBIENT_BLOCKS = [
  /<([a-zA-Z][\w-]*)\b[^>]*\bsource="ambient-[^"]*"[^>]*>[\s\S]*?<\/\1>/g,
  /<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>/g,
];

export function stripAmbientBlocks(message: string): string {
  let out = message;
  for (const re of AMBIENT_BLOCKS) out = out.replace(re, "");
  return out.trim();
}

// custom_tool_call name "exec" carries a JS-call string like
// `tools.exec_command({cmd:"git diff --stat", workdir:"/w"})` — pull out the
// cmd string literal (JSON-compatible escapes) rather than pretending the
// whole JS expression is a command.
function extractExecCmd(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const m = input.match(/\bcmd\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (!m) return undefined;
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return m[1];
  }
}

// custom_tool_call_output / function_call_output payloads: a plain string or
// an array of {type:"input_text", text} parts.
function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output
      .map((p) => (p && typeof p === "object" && typeof (p as any).text === "string" ? (p as any).text : ""))
      .join("");
  }
  return "";
}

// 0.144+ rollouts carry no error events at all — failure must be INFERRED
// from tool output text. Deliberately conservative: only the exec harness's
// own verdict ("Script failed" as the first line) or an explicit nonzero
// exit-code first line count. Error-looking text buried inside otherwise
// successful output (an `ls` complaint mid-script, a quoted traceback) is
// NOT treated as a session error — false failures are worse than missed ones.
const HARNESS_NOISE = /^(Script failed\b.*|Wall time .*|Output:|Script error:)$/;

function inferFailure(text: string): string | undefined {
  const lines = text.split("\n");
  const first = (lines[0] ?? "").trim();
  if (/^Script failed\b/.test(first)) {
    const msg = lines.map((l) => l.trim()).find((l) => l && !HARNESS_NOISE.test(l));
    return msg ?? "exec failed";
  }
  if (/\bexit(?:ed)?\s+(?:with\s+)?code\s+[1-9]\d*\b/i.test(first)) return first;
  return undefined;
}

export function parseCodexSession(text: string, titles: Map<string, string>, path?: string, clip: Clip = makeClip([])): RawSession | null {
  let cwd = "";
  let sessionId = "";
  let startedAt: string | undefined;
  let lastEventAt: string | undefined;
  let awaitingUser = false;
  let midWork = false;
  const events: AgentEvent[] = [];
  const errors: string[] = [];
  const filesTouched = new Set<string>();
  let lastCommand: string | undefined;
  let derivedTitle: string | undefined;
  // Classification inputs (asl-n7l): session_meta.source + turn_context.model
  // and sandbox_policy. A guardian auto-review meta-session announces itself
  // either way (subagent-shaped source, or the codex-auto-review model).
  let source: unknown;
  let subagentSource = false;
  let autoReviewModel = false;
  let readOnlySandbox = false;

  for (const entry of jsonlEntries(text, path)) {
    const ts = typeof entry.timestamp === "string" ? toUtcIso(entry.timestamp) : undefined;
    if (ts) {
      if (!startedAt || ts < startedAt) startedAt = ts;
      if (!lastEventAt || ts > lastEventAt) lastEventAt = ts;
    }
    if (entry.type === "session_meta" && entry.payload) {
      if (typeof entry.payload.cwd === "string") cwd = entry.payload.cwd;
      const id = entry.payload.id ?? entry.payload.session_id;
      if (typeof id === "string") sessionId = id;
      source = entry.payload.source;
      if (source && typeof source === "object" && "subagent" in (source as object)) subagentSource = true;
      continue;
    }
    if (entry.type === "turn_context" && entry.payload) {
      if (typeof entry.payload.cwd === "string" && !cwd) cwd = entry.payload.cwd;
      if (entry.payload.model === "codex-auto-review") autoReviewModel = true;
      if (entry.payload.sandbox_policy?.type === "read-only") readOnlySandbox = true;
      continue;
    }
    // 0.144+ moved exec activity out of event_msg into top-level
    // response_item records: custom_tool_call (name "exec" wraps a shell
    // command), custom_tool_call_output, and generic function_call(_output).
    // Ball-in-court / mid-work rule for the new schema, mirroring the
    // claude-code connector: any tool call in flight OR a tool output the
    // agent has not yet answered means work is visibly in flight (midWork),
    // and only agent_message / task_complete hand the ball to the human.
    // A session whose newest records are tool activity is a working agent,
    // never awaiting-user.
    if (entry.type === "response_item" && entry.payload && ts) {
      const p = entry.payload;
      switch (p.type) {
        case "custom_tool_call":
        case "function_call": {
          const name = String(p.name ?? "tool");
          const cmd = name === "exec" ? extractExecCmd(p.input) : undefined;
          if (cmd) {
            // Stored raw; clipped (redacted + sliced) only at output points.
            lastCommand = cmd;
            events.push({ timestamp: ts, type: "run_progressed", summary: `exec: ${clip(cmd)}` });
          } else {
            events.push({ timestamp: ts, type: "run_progressed", summary: `tool: ${clip(name)}` });
          }
          awaitingUser = false;
          midWork = true;
          break;
        }
        case "custom_tool_call_output":
        case "function_call_output": {
          const failure = inferFailure(outputText(p.output));
          if (failure) {
            const base = clip(failure);
            const msg = lastCommand ? withContext(base, "exec", lastCommand, clip) : base;
            errors.push(msg);
            events.push({ timestamp: ts, type: "failed", summary: msg });
          }
          lastCommand = undefined; // don't blame a finished command for a later error
          awaitingUser = false;
          midWork = true; // output delivered, agent still owes processing
          break;
        }
        default:
          break; // message / reasoning / web_search_call: no event signal
      }
      continue;
    }
    if (entry.type === "event_msg" && entry.payload && ts) {
      const p = entry.payload;
      switch (p.type) {
        case "user_message": {
          // The human's task text — after stripping injected ambient UI
          // blocks. An ambient-only message bears no task: no event, no title.
          // Guardian meta-sessions carry giant agent-history dumps as their
          // user_message — never a task, never a title.
          const task = subagentSource || autoReviewModel ? "" : stripAmbientBlocks(String(p.message ?? ""));
          if (task) {
            events.push({ timestamp: ts, type: "run_progressed", summary: `task: ${clip(task)}` });
            if (!derivedTitle) derivedTitle = clip(task, TITLE_MAX);
          }
          awaitingUser = false;
          midWork = true;
          break;
        }
        case "task_started":
          events.push({ timestamp: ts, type: "run_progressed", summary: p.type });
          awaitingUser = false;
          midWork = true;
          break;
        case "agent_message": {
          const msg = typeof p.message === "string" && p.message.trim() ? clip(p.message) : "agent replied";
          events.push({ timestamp: ts, type: "run_progressed", summary: msg });
          awaitingUser = true;
          midWork = false;
          break;
        }
        case "task_complete": {
          const base = clip(String(p.last_agent_message ?? "task complete"));
          const dur = typeof p.duration_ms === "number" ? ` (${Math.round(p.duration_ms / 1000)}s)` : "";
          events.push({ timestamp: ts, type: "completed", summary: `${base}${dur}` });
          awaitingUser = true;
          midWork = false;
          break;
        }
        case "patch_apply_end": {
          // The only honest file-list source in codex rollouts: apply_patch
          // reports the exact paths it changed. Exec cmd strings are never
          // mined for file names — that would be guessing.
          const changes = p.changes;
          if (changes && typeof changes === "object") {
            for (const f of Object.keys(changes)) filesTouched.add(f);
            events.push({ timestamp: ts, type: "artifact_created", summary: `patch applied: ${Object.keys(changes).length} file(s)` });
          }
          awaitingUser = false;
          midWork = true;
          break;
        }
        // Legacy branches (pre-0.144 rollouts routed exec activity and errors
        // through event_msg). Kept intact so older session files on disk
        // still parse; new files simply never produce these types.
        case "exec_command_begin":
          // Stored raw; clipped (redacted + sliced) only at the output point.
          lastCommand = String(Array.isArray(p.command) ? p.command.join(" ") : (p.command ?? ""));
          awaitingUser = false;
          midWork = true;
          break;
        case "exec_command_end":
          lastCommand = undefined;    // don't blame a finished command for a later error
          break;
        case "error":
        case "stream_error": {
          const base = clip(String(p.message ?? "error"));
          const msg = lastCommand ? withContext(base, "exec", lastCommand, clip) : base;
          errors.push(msg);
          events.push({ timestamp: ts, type: "failed", summary: msg });
          awaitingUser = false;
          midWork = false;
          break;
        }
        case "exec_approval_request":
        case "apply_patch_approval_request":
          events.push({ timestamp: ts, type: "approval_requested", summary: `approval requested: ${clip(String(p.command ?? p.type))}` });
          awaitingUser = false;
          midWork = true;
          break;
        default:
          break; // token_count, thread_settings_applied, …: no signal
      }
    }
  }

  if (!sessionId || !startedAt || !lastEventAt) return null;
  const guardian = subagentSource || autoReviewModel;
  const review = !guardian && source === "mcp" && readOnlySandbox;
  return {
    platform: "codex",
    sessionId,
    cwd: cwd || "unknown",
    startedAt,
    lastEventAt,
    // First task-bearing user_message wins; session_index.jsonl is stale
    // (stopped updating) so the index title is a fallback only. Guardian
    // sessions carry no title at all — their user_message is a transcript
    // dump, not a task (and they are excluded at scan anyway).
    title: guardian ? undefined : derivedTitle ?? titles.get(sessionId),
    events: [{ timestamp: startedAt, type: "run_started", summary: "session started" }, ...events],
    filesTouched: [...filesTouched].sort(),
    errors,
    awaitingUser,
    midWork,
    ...(guardian ? { sessionKind: "guardian" as const } : review ? { sessionKind: "review" as const } : {}),
  };
}

export function loadCodexTitles(rootDir: string): Map<string, string> {
  const titles = new Map<string, string>();
  const indexPath = join(rootDir, "session_index.jsonl");
  if (!existsSync(indexPath)) return titles;
  for (const e of jsonlEntries(readFileSync(indexPath, "utf8"), indexPath)) {
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
  const clip = makeClip(opts.redactPatterns);
  for (const dir of dateDirsInWindow(sessionsDir, opts.since, opts.now)) {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".jsonl")) continue;
      const path = join(dir, file);
      const session = scanSessionFile(path, opts, (text) => parseCodexSession(text, titles, path, clip));
      // Guardian auto-review meta-sessions are approval reviewers watching a
      // real agent, not working agents — surfacing them double-counts every
      // guarded session as a phantom twin. Excluded here, tagged at parse.
      if (session && session.sessionKind !== "guardian") out.push(session);
    }
  }
  return out;
}
