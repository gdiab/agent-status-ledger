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
        stdout: JSON.stringify({ sessions: [{ session_id: "deadbeef", confidence: 325.0 }] }),
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

  // End-to-end through the real pipeline: a session with no file edits and no
  // commits infers claimed_only, and the connector keys off its harness
  // session UUID (which ASL always has) — not facts.filesTouched (which is
  // guaranteed empty exactly when the claimed_only gate opens).
  test("engram enrichment upgrades a real claimed_only profile via its session UUID, and stays claimed_only on failure", async () => {
    const world = mkdtempSync(join(tmpdir(), "asl-report-"));
    const ccRoot = join(world, "claude-projects");
    const dir = join(ccRoot, "-work-p0");
    mkdirSync(dir, { recursive: true });
    const f = join(dir, "s.jsonl");
    // Long enough not to be trivial; no file edits → evidence claimed_only.
    writeFileSync(f, [
      JSON.stringify({
        type: "user", timestamp: "2026-07-07T12:00:00.000Z", cwd: "/work/p0",
        sessionId: "cc-p0", message: { role: "user", content: "task" },
      }),
      JSON.stringify({
        type: "assistant", timestamp: "2026-07-07T12:05:00.000Z", cwd: "/work/p0",
        sessionId: "cc-p0", message: { role: "assistant", content: "done" },
      }),
    ].join("\n") + "\n");
    utimesSync(f, MTIME, MTIME);

    const config = defaultConfig();
    config.connectors.claudeCode.rootDir = ccRoot;
    config.connectors.codex.enabled = false;
    config.connectors.engram = { enabled: true, binaryPath: "/fake/engram" };

    const matchExec: Exec = (argv) => {
      if (argv[1] === "grep" && argv[2] === "cc-p0") {
        return {
          ok: true,
          stdout: JSON.stringify({ sessions: [{ session_id: "engram-sid-1", confidence: 12.0 }] }),
          stderr: "",
        };
      }
      if (argv[1] === "peek" && argv[2] === "engram-sid-1") {
        return {
          ok: true,
          stdout: JSON.stringify({
            session: {
              content: [{
                line: 1,
                text: JSON.stringify({
                  file: "/work/p0/src/app.ts", k: "code.edit",
                  source: { harness: "claude-code", session_id: "cc-p0" }, t: "t",
                }),
              }],
            },
          }),
          stderr: "",
        };
      }
      return { ok: true, stdout: JSON.stringify({ error: "no_results" }), stderr: "" };
    };

    const upgraded = await buildReport({ since: SINCE, now: NOW, config, useLlm: false, engramExec: matchExec });
    const agent = upgraded.agents.find((a) => a.workdir === "/work/p0")!;
    expect(agent.evidence).toBe("partially_proven");
    expect(agent.evidenceCitation).toContain("engram-sid-1");
    expect(agent.evidenceCitation).toContain("/work/p0/src/app.ts");

    // Every failure path leaves the inferred level untouched.
    const failingExec: Exec = () => ({ ok: false, stdout: "", stderr: "engram: not found" });
    const untouched = await buildReport({ since: SINCE, now: NOW, config, useLlm: false, engramExec: failingExec });
    const agent2 = untouched.agents.find((a) => a.workdir === "/work/p0")!;
    expect(agent2.evidence).toBe("claimed_only");
    expect(agent2.evidenceCitation).toBeUndefined();
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
// calls after inferStatus. It operates on the profile's harness session
// UUIDs (RawSession.sessionId — always present, even when file-history
// detection found nothing, which is exactly the claimed_only case) so it's
// tested directly here on plain values — see also the "engram enrichment
// never touches an already-proven report" buildReport-level test above,
// which covers the same gate end-to-end through the real connector pipeline.
describe("applyEngramEnrichment", () => {
  const enabledEngram = { enabled: true, binaryPath: "/fake/engram" };
  const disabledEngram = { enabled: false, binaryPath: "/fake/engram" };
  const UUID = "989533ee-ec57-4ac9-b510-9d6cb8b1b969";
  const ENGRAM_SID = "cbe8ebd4deadbeef";

  // grep→peek mock: any grep returns one candidate; its peek carries a
  // code.edit event whose source.session_id echoes the grepped UUID, so
  // whichever session UUID is queried, the guard passes.
  const matchExec: Exec = (argv) => {
    if (argv[1] === "grep") {
      return {
        ok: true,
        stdout: JSON.stringify({ sessions: [{ session_id: ENGRAM_SID, confidence: 325.0 }] }),
        stderr: "",
      };
    }
    // peek — bind the emitted event to the most recently grepped UUID via a
    // static event on the known UUID (tests only query UUID here).
    return {
      ok: true,
      stdout: JSON.stringify({
        session: {
          content: [
            {
              line: 1,
              text: JSON.stringify({
                file: "/repo/src/thing.ts",
                k: "code.edit",
                source: { harness: "claude-code", session_id: UUID },
                t: "t",
              }),
            },
          ],
        },
      }),
      stderr: "",
    };
  };
  const noMatchExec: Exec = () => ({
    ok: true,
    stdout: JSON.stringify({ error: "no_results", query: UUID }),
    stderr: "",
  });
  const throwingExec: Exec = () => {
    throw new Error("boom");
  };

  for (const evidence of ["proven", "partially_proven", "unknown"] as EvidenceLevel[]) {
    test(`leaves ${evidence} untouched even on a match — only claimed_only is eligible`, async () => {
      const r = await applyEngramEnrichment(evidence, [UUID], enabledEngram, matchExec);
      expect(r.evidence).toBe(evidence);
      expect(r.evidenceCitation).toBeUndefined();
    });
  }

  test("leaves claimed_only untouched when the connector is disabled, even on a match", async () => {
    const r = await applyEngramEnrichment("claimed_only", [UUID], disabledEngram, matchExec);
    expect(r.evidence).toBe("claimed_only");
    expect(r.evidenceCitation).toBeUndefined();
  });

  test("leaves claimed_only untouched when no exec seam was supplied", async () => {
    const r = await applyEngramEnrichment("claimed_only", [UUID], enabledEngram, undefined);
    expect(r.evidence).toBe("claimed_only");
  });

  test("leaves claimed_only untouched when there are no session ids to check", async () => {
    const r = await applyEngramEnrichment("claimed_only", [], enabledEngram, matchExec);
    expect(r.evidence).toBe("claimed_only");
  });

  test("leaves claimed_only untouched when engram finds no match", async () => {
    const r = await applyEngramEnrichment("claimed_only", [UUID], enabledEngram, noMatchExec);
    expect(r.evidence).toBe("claimed_only");
  });

  test("leaves claimed_only untouched, fail-soft, when exec throws", async () => {
    const r = await applyEngramEnrichment("claimed_only", [UUID], enabledEngram, throwingExec);
    expect(r.evidence).toBe("claimed_only");
  });

  test("upgrades claimed_only to partially_proven with a citation on a real match", async () => {
    const r = await applyEngramEnrichment("claimed_only", [UUID], enabledEngram, matchExec);
    expect(r.evidence).toBe("partially_proven");
    expect(r.evidenceCitation).toContain(ENGRAM_SID);
    expect(r.evidenceCitation).toContain("/repo/src/thing.ts");
  });

  test("stops at the first matching session and doesn't keep querying afterward", async () => {
    const otherA = "aaaaaaaa-0000-0000-0000-000000000000";
    const otherB = "bbbbbbbb-0000-0000-0000-000000000000";
    const grepped: string[] = [];
    const exec: Exec = (argv) => {
      if (argv[1] === "grep") {
        grepped.push(argv[2]!);
        if (argv[2] !== UUID) {
          return { ok: true, stdout: JSON.stringify({ error: "no_results" }), stderr: "" };
        }
        return {
          ok: true,
          stdout: JSON.stringify({ sessions: [{ session_id: ENGRAM_SID, confidence: 42.0 }] }),
          stderr: "",
        };
      }
      return {
        ok: true,
        stdout: JSON.stringify({
          session: {
            content: [
              {
                line: 1,
                text: JSON.stringify({
                  file: "/repo/src/x.ts",
                  k: "code.edit",
                  source: { harness: "claude-code", session_id: UUID },
                  t: "t",
                }),
              },
            ],
          },
        }),
        stderr: "",
      };
    };
    const r = await applyEngramEnrichment("claimed_only", [otherA, UUID, otherB], enabledEngram, exec);
    expect(r.evidence).toBe("partially_proven");
    expect(grepped).toEqual([otherA, UUID]); // never greps otherB
  });
});
