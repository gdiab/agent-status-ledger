import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReport, isTrivialProfile } from "../src/report";
import { defaultConfig } from "../src/config";
import type { AgentProfile, CommitEvidence, RawSession } from "../src/types";

const NOW = new Date("2026-07-08T07:00:00.000Z");
const SINCE = new Date("2026-07-07T07:00:00.000Z");
// Session files are written at test-run time; pin mtime inside the SINCE/NOW window
// so the connector's mtime filter doesn't depend on when the test happens to run.
const MTIME = new Date("2026-07-07T12:00:00.000Z");

async function run(cwd: string, cmd: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(`${cmd.join(" ")} failed`);
}

describe("buildReport", () => {
  test("redacts commit subjects at the model layer, not only in the CLI's final render pass", async () => {
    const world = mkdtempSync(join(tmpdir(), "asl-report-"));

    const repo = join(world, "repo");
    mkdirSync(repo);
    await run(repo, ["git", "init", "-q"]);
    await run(repo, ["git", "config", "user.email", "t@t.test"]);
    await run(repo, ["git", "config", "user.name", "t"]);
    // Commit subject carries a secret-shaped string; authored inside the claude-code
    // session window below (09:00-09:30) so it's attributed evidence.
    await run(repo, ["git", "commit", "-q", "--allow-empty", "-m", "fix auth, password=hunter2secret"],
      { GIT_AUTHOR_DATE: "2026-07-07T09:20:00Z", GIT_COMMITTER_DATE: "2026-07-07T09:20:00Z" });

    const ccRoot = join(world, "claude-projects");
    const enc = repo.replace(/\//g, "-");
    mkdirSync(join(ccRoot, enc), { recursive: true });
    const completed = readFileSync("fixtures/claude-code/session-completed.jsonl", "utf8")
      .replaceAll("/work/demo", repo);
    const s1 = join(ccRoot, enc, "s1.jsonl");
    writeFileSync(s1, completed);
    utimesSync(s1, MTIME, MTIME);

    const config = defaultConfig();
    config.connectors.claudeCode.rootDir = ccRoot;
    config.connectors.codex.enabled = false;

    const report = await buildReport({ since: SINCE, now: NOW, config, useLlm: false });

    const agent = report.agents.find((a) => a.workdir === repo)!;
    expect(agent).toBeDefined();
    expect(agent.commits.length).toBeGreaterThan(0);
    expect(agent.commits[0]!.subject).toContain("[REDACTED]");
    expect(agent.commits[0]!.subject).not.toContain("hunter2secret");
  });

  test("runs per-profile work concurrently with a bounded pool", async () => {
    const world = mkdtempSync(join(tmpdir(), "asl-report-"));
    const ccRoot = join(world, "claude-projects");
    for (let i = 0; i < 5; i++) {
      const dir = join(ccRoot, `-work-p${i}`);
      mkdirSync(dir, { recursive: true });
      const f = join(dir, "s.jsonl");
      // Two events, 5 minutes apart: keeps the session comfortably above
      // minSessionSeconds (60s) so isTrivialProfile doesn't filter these
      // synthetic profiles out before they reach the (mocked) LLM path.
      writeFileSync(f, [
        JSON.stringify({
          type: "user", timestamp: "2026-07-07T12:00:00.000Z", cwd: `/work/p${i}`,
          sessionId: `cc-p${i}`, message: { role: "user", content: "task" },
        }),
        JSON.stringify({
          type: "assistant", timestamp: "2026-07-07T12:05:00.000Z", cwd: `/work/p${i}`,
          sessionId: `cc-p${i}`, message: { role: "assistant", content: "done" },
        }),
      ].join("\n") + "\n");
      utimesSync(f, MTIME, MTIME);
    }
    const config = defaultConfig();
    config.connectors.claudeCode.rootDir = ccRoot;
    config.connectors.codex.enabled = false;

    let inflight = 0;
    let maxInflight = 0;
    // Barrier, not sleeps: the first two calls hold until both have arrived,
    // so maxInflight >= 2 is guaranteed rather than won by a timing race.
    let released = false;
    const waiters: Array<() => void> = [];
    const gate = () =>
      new Promise<void>((resolve) => {
        if (released) return resolve();
        waiters.push(resolve);
        if (waiters.length >= 2) {
          released = true;
          for (const w of waiters) w();
        }
      });
    const canned = JSON.stringify({ workedOn: "w", completed: "c", inProgress: "i", blocked: "b", recommendation: "r" });
    const fetchFn = (async () => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await gate();
      inflight--;
      return new Response(JSON.stringify({ content: [{ type: "text", text: canned }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const report = await buildReport({ since: SINCE, now: NOW, config, useLlm: true, apiKey: "k", fetchFn });
    expect(report.agents.length).toBe(5);
    expect(report.agents.every((a) => a.narrativeSource === "llm")).toBe(true);
    expect(maxInflight).toBeGreaterThanOrEqual(2); // actually parallel
    expect(maxInflight).toBeLessThanOrEqual(4);    // but bounded
  });
});

function sess(over: Partial<RawSession>): RawSession {
  return {
    platform: "claude-code", sessionId: "s", cwd: "/w",
    startedAt: "2026-07-07T10:00:00.000Z", lastEventAt: "2026-07-07T10:00:10.000Z",  // 10s
    events: [{ timestamp: "2026-07-07T10:00:00.000Z", type: "run_started", summary: "x" }],
    filesTouched: [], errors: [],
    ...over,
  };
}
function prof(sessions: RawSession[]): AgentProfile {
  return { profileId: "claude-code:/w", platform: "claude-code", workdir: "/w", displayName: "w (claude-code)", sessions };
}
const attributedCommit: CommitEvidence = { sha: "a".repeat(40), authorDate: "2026-07-07T10:00:05.000Z", subject: "x", attributed: true };

describe("isTrivialProfile", () => {
  test("all-short, artifact-free profile is trivial", () => {
    expect(isTrivialProfile(prof([sess({}), sess({ sessionId: "s2" })]), [], 60)).toBe(true);
  });

  test("one long session defeats triviality", () => {
    const long = sess({ lastEventAt: "2026-07-07T10:05:00.000Z" });  // 5 min
    expect(isTrivialProfile(prof([sess({}), long]), [], 60)).toBe(false);
  });

  test("files touched, errors, or an attributed commit each defeat triviality", () => {
    expect(isTrivialProfile(prof([sess({ filesTouched: ["/w/a.ts"] })]), [], 60)).toBe(false);
    expect(isTrivialProfile(prof([sess({ errors: ["boom"] })]), [], 60)).toBe(false);
    expect(isTrivialProfile(prof([sess({})]), [attributedCommit], 60)).toBe(false);
    expect(isTrivialProfile(prof([sess({})]), [{ ...attributedCommit, attributed: false }], 60)).toBe(true);
  });

  test("single-event zero-duration silent-shaped profile is still trivial (accepted edge)", () => {
    // startedAt === lastEventAt (a single logged event) reads as a 0s session
    // regardless of how long ago it happened. isTrivialProfile only looks at
    // the session's own span, not recency from `now` — a genuinely stale,
    // single-event profile is filtered as noise (hidden from cards, still
    // named in Report.trivialProfiles) rather than surfaced as `silent`.
    const zeroDuration = sess({ lastEventAt: "2026-07-07T10:00:00.000Z" });
    expect(isTrivialProfile(prof([zeroDuration]), [], 60)).toBe(true);
  });
});
