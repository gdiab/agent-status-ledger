import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCodexSession, scanCodex } from "../src/connectors/codex";

const completed = readFileSync("fixtures/codex/rollout-completed.jsonl", "utf8");
const approval = readFileSync("fixtures/codex/rollout-approval.jsonl", "utf8");
const titles = new Map([
  ["cx-blog-1", "Write launch blog post"],
  ["cx-deploy-1", "Terraform deploy"],
]);

describe("parseCodexSession", () => {
  test("completed session: meta, title, completed event", () => {
    const s = parseCodexSession(completed, titles)!;
    expect(s.platform).toBe("codex");
    expect(s.sessionId).toBe("cx-blog-1");
    expect(s.cwd).toBe("/work/blog");
    expect(s.title).toBe("Write launch blog post");
    expect(s.startedAt).toBe("2026-07-07T11:00:00.000Z");
    expect(s.lastEventAt).toBe("2026-07-07T11:40:01.000Z");
    expect(s.events.some((e) => e.type === "completed")).toBe(true);
  });

  test("approval session emits approval_requested", () => {
    const s = parseCodexSession(approval, titles)!;
    expect(s.events.at(-1)!.type).toBe("approval_requested");
    expect(s.events.at(-1)!.summary).toContain("terraform apply");
  });

  test("no session_meta and no timestamps returns null", () => {
    expect(parseCodexSession("garbage\n", titles)).toBeNull();
  });
});

describe("scanCodex", () => {
  test("walks date dirs inside window and applies index titles", async () => {
    const root = mkdtempSync(join(tmpdir(), "asl-cx-"));
    const day = join(root, "sessions", "2026", "07", "07");
    mkdirSync(day, { recursive: true });
    const filePath = join(day, "rollout-2026-07-07T11-00-00-cx-blog-1.jsonl");
    cpSync("fixtures/codex/rollout-completed.jsonl", filePath);
    // Pin mtime to ensure deterministic behavior
    const d = new Date("2026-07-07T12:00:00.000Z");
    utimesSync(filePath, d, d);
    cpSync("fixtures/codex/session_index.jsonl", join(root, "session_index.jsonl"));
    const now = new Date("2026-07-08T09:00:00.000Z");
    const sessions = await scanCodex({ since: new Date(now.getTime() - 86_400_000), now, rootDir: root });
    expect(sessions.length).toBe(1);
    expect(sessions[0]!.title).toBe("Write launch blog post");
  });

  test("missing rootDir returns empty", async () => {
    expect(await scanCodex({ since: new Date(), now: new Date(), rootDir: "/nope" })).toEqual([]);
  });
});
