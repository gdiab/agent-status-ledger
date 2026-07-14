import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEngramEnrichment, buildReport, isTrivialProfile } from "../src/report";
import { defaultConfig } from "../src/config";
import type { AgentProfile, CommitEvidence, EvidenceLevel, RawSession } from "../src/types";
import type { Exec } from "../src/connectors/engram";

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

  test("engram enrichment never touches an already-proven report, even on a mocked match", async () => {
    const world = mkdtempSync(join(tmpdir(), "asl-report-"));

    const repo = join(world, "repo");
    mkdirSync(repo);
    await run(repo, ["git", "init", "-q"]);
    await run(repo, ["git", "config", "user.email", "t@t.test"]);
    await run(repo, ["git", "config", "user.name", "t"]);
    await run(repo, ["git", "commit", "-q", "--allow-empty", "-m", "fix auth"],
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
    config.connectors.engram = { enabled: true, binaryPath: "/fake/engram" };

    let calls = 0;
    const alwaysMatchExec: Exec = () => {
      calls++;
      return {
        ok: true,
        stdout: JSON.stringify({
          sessions: [{ session_id: "x", confidence: 1, timestamp: "t", files_touched: ["anything"] }],
        }),
        stderr: "",
      };
    };

    const report = await buildReport({
      since: SINCE, now: NOW, config, useLlm: false, engramExec: alwaysMatchExec,
    });
    const agent = report.agents.find((a) => a.workdir === repo)!;
    expect(agent.evidence).toBe("proven");
    expect(agent.evidenceCitation).toBeUndefined();
    // gate is on evidence level, not on whether exec would have matched
    expect(calls).toBe(0);
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

  test("a short session with midWork true is NOT trivial (agent work visibly in flight)", () => {
    const midWork = sess({ midWork: true });  // 10s, same shape as the trivial baseline
    expect(isTrivialProfile(prof([midWork]), [], 60)).toBe(false);
  });

  test("the plain-unanswered-user-message junk shape (sub-minute, no files/errors/commits, midWork false) stays trivial", () => {
    const junk = sess({ midWork: false, awaitingUser: false });
    expect(isTrivialProfile(prof([junk]), [], 60)).toBe(true);
  });
});

// applyEngramEnrichment is the exact function report.ts's per-profile loop
// calls after inferStatus. It operates on plain values (not a scanned
// AgentProfile) so it's tested directly here rather than only through a full
// buildReport run — see also the "engram enrichment never touches an
// already-proven report" buildReport-level test above, which covers the same
// gate end-to-end through the real connector pipeline.
//
// Deviation note: under inferStatus's current formula (src/status.ts),
// evidence is "claimed_only" if and only if no session in the profile has
// any filesTouched — so a real buildReport run can never simultaneously
// produce evidence: "claimed_only" and a non-empty facts.filesTouched. That
// makes the claimed_only -> partially_proven upgrade path untestable through
// the full pipeline today; it's still real, live code (forward-compatible
// with any future FactSheet file source, e.g. commit-changed-files), so it's
// tested directly against applyEngramEnrichment instead.
describe("applyEngramEnrichment", () => {
  const enabledEngram = { enabled: true, binaryPath: "/fake/engram" };
  const disabledEngram = { enabled: false, binaryPath: "/fake/engram" };
  const FILE = "/repo/src/thing.ts";

  const matchExec: Exec = () => ({
    ok: true,
    stdout: JSON.stringify({
      sessions: [{ session_id: "s1", confidence: 0.9, timestamp: "2026-07-07T10:00:00Z", files_touched: [FILE] }],
    }),
    stderr: "",
  });
  const noMatchExec: Exec = () => ({
    ok: true,
    stdout: JSON.stringify({ error: "no_results", query: FILE }),
    stderr: "",
  });
  const throwingExec: Exec = () => {
    throw new Error("boom");
  };

  for (const evidence of ["proven", "partially_proven", "unknown"] as EvidenceLevel[]) {
    test(`leaves ${evidence} untouched even on a match — only claimed_only is eligible`, async () => {
      const r = await applyEngramEnrichment(evidence, [FILE], enabledEngram, matchExec);
      expect(r.evidence).toBe(evidence);
      expect(r.evidenceCitation).toBeUndefined();
    });
  }

  test("leaves claimed_only untouched when the connector is disabled, even on a match", async () => {
    const r = await applyEngramEnrichment("claimed_only", [FILE], disabledEngram, matchExec);
    expect(r.evidence).toBe("claimed_only");
    expect(r.evidenceCitation).toBeUndefined();
  });

  test("leaves claimed_only untouched when no exec seam was supplied", async () => {
    const r = await applyEngramEnrichment("claimed_only", [FILE], enabledEngram, undefined);
    expect(r.evidence).toBe("claimed_only");
  });

  test("leaves claimed_only untouched when there are no files to check", async () => {
    const r = await applyEngramEnrichment("claimed_only", [], enabledEngram, matchExec);
    expect(r.evidence).toBe("claimed_only");
  });

  test("leaves claimed_only untouched when engram finds no match", async () => {
    const r = await applyEngramEnrichment("claimed_only", [FILE], enabledEngram, noMatchExec);
    expect(r.evidence).toBe("claimed_only");
  });

  test("leaves claimed_only untouched, fail-soft, when exec throws", async () => {
    const r = await applyEngramEnrichment("claimed_only", [FILE], enabledEngram, throwingExec);
    expect(r.evidence).toBe("claimed_only");
  });

  test("upgrades claimed_only to partially_proven with a citation on a real match", async () => {
    const r = await applyEngramEnrichment("claimed_only", [FILE], enabledEngram, matchExec);
    expect(r.evidence).toBe("partially_proven");
    expect(r.evidenceCitation).toContain("s1");
  });

  test("stops at the first matching file and doesn't keep querying afterward", async () => {
    let calls: string[] = [];
    const exec: Exec = (argv) => {
      calls.push(argv[argv.length - 1]!);
      const file = argv[argv.length - 1];
      const matches = file === FILE;
      return {
        ok: true,
        stdout: JSON.stringify({
          sessions: matches
            ? [{ session_id: "s1", confidence: 0.9, timestamp: "t", files_touched: [FILE] }]
            : [],
        }),
        stderr: "",
      };
    };
    const r = await applyEngramEnrichment("claimed_only", ["/other/a.ts", FILE, "/other/b.ts"], enabledEngram, exec);
    expect(r.evidence).toBe("partially_proven");
    expect(calls).toEqual(["/other/a.ts", FILE]); // never reaches /other/b.ts
  });
});
