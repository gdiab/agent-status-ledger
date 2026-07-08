import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReport } from "../src/report";
import { renderMarkdown } from "../src/render/markdown";
import { renderJson } from "../src/render/json";
import { defaultConfig } from "../src/config";

const NOW = new Date("2026-07-08T07:00:00.000Z");
const SINCE = new Date("2026-07-07T07:00:00.000Z");
// Session files are written at test-run time, but connectors filter by mtime
// against SINCE/NOW above. Pin every session file's mtime inside that window
// so this test doesn't rot as real time moves past the pinned NOW.
const MTIME = new Date("2026-07-07T12:00:00.000Z");

async function run(cwd: string, cmd: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(`${cmd.join(" ")} failed`);
}

async function buildWorld() {
  const world = mkdtempSync(join(tmpdir(), "asl-golden-"));
  // git repo the claude-code fixture "worked" in
  const repo = join(world, "repo");
  mkdirSync(repo);
  await run(repo, ["git", "init", "-q"]);
  await run(repo, ["git", "config", "user.email", "t@t.test"]);
  await run(repo, ["git", "config", "user.name", "t"]);
  await run(repo, ["git", "commit", "-q", "--allow-empty", "-m", "fix login redirect"],
    { GIT_AUTHOR_DATE: "2026-07-07T09:20:00Z", GIT_COMMITTER_DATE: "2026-07-07T09:20:00Z" });
  await run(repo, ["git", "commit", "-q", "--allow-empty", "-m", "human hotfix, not agent work"],
    { GIT_AUTHOR_DATE: "2026-07-07T15:00:00Z", GIT_COMMITTER_DATE: "2026-07-07T15:00:00Z" });

  // claude-code home: completed session in repo + silent session elsewhere
  const ccRoot = join(world, "claude-projects");
  const enc = repo.replace(/\//g, "-");
  mkdirSync(join(ccRoot, enc), { recursive: true });
  const completed = readFileSync("fixtures/claude-code/session-completed.jsonl", "utf8")
    .replaceAll("/work/demo", repo);
  const s1 = join(ccRoot, enc, "s1.jsonl");
  writeFileSync(s1, completed);
  utimesSync(s1, MTIME, MTIME);
  mkdirSync(join(ccRoot, "-work-silent"), { recursive: true });
  const s2 = join(ccRoot, "-work-silent", "s2.jsonl");
  writeFileSync(s2, JSON.stringify({
    type: "user", timestamp: "2026-07-07T12:00:00.000Z", cwd: "/work/silent", sessionId: "cc-silent-1",
    message: { role: "user", content: "long task" },
  }) + "\n");
  utimesSync(s2, MTIME, MTIME);

  // codex home: approval-blocked session
  const cxRoot = join(world, "codex");
  mkdirSync(join(cxRoot, "sessions", "2026", "07", "07"), { recursive: true });
  const rollout = join(cxRoot, "sessions", "2026", "07", "07", "rollout-a.jsonl");
  cpSync("fixtures/codex/rollout-approval.jsonl", rollout);
  utimesSync(rollout, MTIME, MTIME);
  const sessionIndex = join(cxRoot, "session_index.jsonl");
  cpSync("fixtures/codex/session_index.jsonl", sessionIndex);
  utimesSync(sessionIndex, MTIME, MTIME);

  const config = defaultConfig();
  config.connectors.claudeCode.rootDir = ccRoot;
  config.connectors.codex.rootDir = cxRoot;
  return { config, repo };
}

describe("golden end-to-end", () => {
  test("pipeline output matches pinned golden files", async () => {
    const { config, repo } = await buildWorld();
    const report = await buildReport({ since: SINCE, now: NOW, config, useLlm: false });

    // structural assertions independent of golden text
    expect(report.agents.length).toBe(3);
    const repoAgent = report.agents.find((a) => a.workdir === repo)!;
    expect(repoAgent.status).toBe("completed");
    expect(repoAgent.evidence).toBe("proven");
    expect(repoAgent.facts.commits).toEqual([expect.stringContaining("fix login redirect")]);
    expect(JSON.stringify(repoAgent.facts.commits)).not.toContain("human hotfix");
    const silent = report.agents.find((a) => a.workdir === "/work/silent")!;
    expect(silent.status).toBe("silent");
    const approval = report.agents.find((a) => a.platform === "codex")!;
    expect(approval.status).toBe("needs_human");
    expect(report.exceptions.map((a) => a.profileId).sort()).toEqual(
      [silent.profileId, approval.profileId].sort());

    // golden comparison with paths normalized (temp dir varies per run)
    const md = renderMarkdown(report).replaceAll(repo, "<REPO>");
    const json = renderJson(report).replaceAll(repo, "<REPO>");
    if (process.env.UPDATE_GOLDEN) {
      writeFileSync("fixtures/golden/report.md", md);
      writeFileSync("fixtures/golden/report.json", json);
    }
    expect(existsSync("fixtures/golden/report.md")).toBe(true);
    expect(md).toBe(readFileSync("fixtures/golden/report.md", "utf8"));
    expect(json).toBe(readFileSync("fixtures/golden/report.json", "utf8"));
  });
});
