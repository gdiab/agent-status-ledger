import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReport, isTrivialProfile } from "../src/report";
import { defaultConfig } from "../src/config";
import type { AgentProfile, CommitEvidence, RawSession } from "../src/types";
import type { Exec } from "../src/exec";
import { markerQuery } from "./helpers/engram-fixtures";

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

  // asl-e2q acceptance: the engram exec seam is async, so a subprocess call
  // in one profile worker must not serialize the others. Two claimed_only
  // profiles each issue one evidence grep inside mapLimit(4); a barrier Exec
  // holds the first grep unresolved until the second arrives. Only a seam
  // that yields the event loop mid-call lets the second worker start while
  // the first is in flight — with the old synchronous seam the first call
  // ran to completion before any other worker could run, so maxInflight
  // could never reach 2. (makeSpawnExec's own event-loop liveness is pinned
  // separately in tests/exec.test.ts; this proves the pipeline keeps it.)
  // Barrier, not sleeps — same convention as the LLM-concurrency test above.
  test("engram subprocess calls interleave across profile workers instead of serializing them", async () => {
    const world = mkdtempSync(join(tmpdir(), "asl-report-"));
    const ccRoot = join(world, "claude-projects");
    const uuids = ["aaaa0000-0000-4000-8000-00000000000a", "bbbb0000-0000-4000-8000-00000000000b"];
    for (let i = 0; i < uuids.length; i++) {
      const dir = join(ccRoot, `-work-p${i}`);
      mkdirSync(dir, { recursive: true });
      const f = join(dir, "s.jsonl");
      // 5 minutes, no file edits, no commits: non-trivial and claimed_only,
      // so each profile's worker reaches the engram evidence grep.
      writeFileSync(f, [
        JSON.stringify({
          type: "user", timestamp: "2026-07-07T12:00:00.000Z", cwd: `/work/p${i}`,
          sessionId: uuids[i], message: { role: "user", content: "task" },
        }),
        JSON.stringify({
          type: "assistant", timestamp: "2026-07-07T12:05:00.000Z", cwd: `/work/p${i}`,
          sessionId: uuids[i], message: { role: "assistant", content: "done" },
        }),
      ].join("\n") + "\n");
      utimesSync(f, MTIME, MTIME);
    }
    const config = defaultConfig();
    config.connectors.claudeCode.rootDir = ccRoot;
    config.connectors.codex.enabled = false;
    config.connectors.engram = { enabled: true, binaryPath: "/fake/engram", beadPrefixes: [] };

    let inflight = 0;
    let maxInflight = 0;
    let released = false;
    const waiters: Array<() => void> = [];
    const gate = () =>
      new Promise<void>((resolve) => {
        if (released) return resolve(); // post-barrier calls (the sequential lineage greps) pass through
        waiters.push(resolve);
        if (waiters.length >= 2) {
          released = true;
          for (const w of waiters) w();
        }
      });
    const exec: Exec = async (argv) => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await gate();
      inflight--;
      expect(argv[0]).toBe("/fake/engram");
      return { ok: true, stdout: JSON.stringify({ error: "no_results" }), stderr: "" };
    };

    const report = await buildReport({ since: SINCE, now: NOW, config, useLlm: false, engramExec: exec });
    expect(report.agents.length).toBe(2);
    expect(report.agents.every((a) => a.evidence === "claimed_only")).toBe(true); // both greps really ran
    expect(maxInflight).toBeGreaterThanOrEqual(2); // both engram calls in flight together
  });

  test("an already-proven profile never triggers engram evidence calls (lineage probes may still run)", async () => {
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
    // UUID-shaped session ids: the fixture's original "cc-fix-1" fails the
    // connector's SESSION_ID_SHAPE allowlist, which used to make this test
    // pass for the wrong reason (every engram path rejected the id before
    // exec, so `calls === 0` proved nothing about the evidence gate).
    const S1 = "989533ee-ec57-4ac9-b510-9d6cb8b1b969";
    const S2 = "aaaa0000-0000-4000-8000-00000000000a";
    const completed = readFileSync("fixtures/claude-code/session-completed.jsonl", "utf8")
      .replaceAll("/work/demo", repo)
      .replaceAll("cc-fix-1", S1);
    const s1 = join(ccRoot, enc, "s1.jsonl");
    writeFileSync(s1, completed);
    utimesSync(s1, MTIME, MTIME);
    // A second session in the same profile so the lineage probe (which needs
    // at least two linkable sessions) genuinely runs.
    const s2 = join(ccRoot, enc, "s2.jsonl");
    writeFileSync(s2, [
      JSON.stringify({
        type: "user", timestamp: "2026-07-07T12:00:00.000Z", cwd: repo,
        sessionId: S2, message: { role: "user", content: "task" },
      }),
      JSON.stringify({
        type: "assistant", timestamp: "2026-07-07T12:05:00.000Z", cwd: repo,
        sessionId: S2, message: { role: "assistant", content: "done" },
      }),
    ].join("\n") + "\n");
    utimesSync(s2, MTIME, MTIME);

    const config = defaultConfig();
    config.connectors.claudeCode.rootDir = ccRoot;
    config.connectors.codex.enabled = false;
    config.connectors.engram = { enabled: true, binaryPath: "/fake/engram", beadPrefixes: [] };

    const calls: string[][] = [];
    const alwaysMatchExec: Exec = async (argv) => {
      calls.push(argv);
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
    // The true invariant: the report-wide lineage probe MAY call engram
    // (it is evidence-level-agnostic), but the evidence upgrade — the only
    // caller that peeks with the code.edit filter — must never run for a
    // proven profile. The gate is on evidence level, not on whether exec
    // would have matched.
    expect(calls.length).toBeGreaterThan(0); // lineage did probe
    expect(calls.some((argv) => argv.includes('"k":"code.edit"'))).toBe(false); // evidence never did
  });

  test("engram enrichment tries a profile's sessions newest-first", async () => {
    const world = mkdtempSync(join(tmpdir(), "asl-report-"));
    const ccRoot = join(world, "claude-projects");
    const dir = join(ccRoot, "-work-p0");
    mkdirSync(dir, { recursive: true });
    // Two sessions in the same cwd: the aaaa... session starts at 11:00, the bbbb... session at 12:00.
    const mkSession = (name: string, sessionId: string, hour: string) => {
      const f = join(dir, name);
      writeFileSync(f, [
        JSON.stringify({
          type: "user", timestamp: `2026-07-07T${hour}:00:00.000Z`, cwd: "/work/p0",
          sessionId, message: { role: "user", content: "task" },
        }),
        JSON.stringify({
          type: "assistant", timestamp: `2026-07-07T${hour}:05:00.000Z`, cwd: "/work/p0",
          sessionId, message: { role: "assistant", content: "done" },
        }),
      ].join("\n") + "\n");
      utimesSync(f, MTIME, MTIME);
    };
    mkSession("old.jsonl", "aaaa0000-0000-4000-8000-00000000000a", "11");
    mkSession("new.jsonl", "bbbb0000-0000-4000-8000-00000000000b", "12");

    const config = defaultConfig();
    config.connectors.claudeCode.rootDir = ccRoot;
    config.connectors.codex.enabled = false;
    config.connectors.engram = { enabled: true, binaryPath: "/fake/engram", beadPrefixes: ["asl"] };

    const grepped: string[] = [];
    const spy: Exec = async (argv) => {
      if (argv[1] === "grep") grepped.push(argv[2]!);
      return { ok: true, stdout: JSON.stringify({ error: "no_results" }), stderr: "" };
    };
    await buildReport({ since: SINCE, now: NOW, config, useLlm: false, engramExec: spy });
    // Newest first: recent sessions are the ones most likely to be in the
    // index and most relevant to today's report. Four engram passes share
    // the seam and all order newest-first: the per-profile evidence upgrade
    // (inside the profile loop) greps the bare uuid, then the report-wide
    // dispatch-lineage probe over the post-filter profiles greps each
    // session's marker literal, then the report-wide task-key probe greps
    // each session's bare uuid again, then the report-wide
    // conversation-signal probe greps each session's bare uuid once more.
    expect(grepped).toEqual([
      "bbbb0000-0000-4000-8000-00000000000b", "aaaa0000-0000-4000-8000-00000000000a", // evidence
      markerQuery("bbbb0000-0000-4000-8000-00000000000b"), markerQuery("aaaa0000-0000-4000-8000-00000000000a"), // lineage
      "bbbb0000-0000-4000-8000-00000000000b", "aaaa0000-0000-4000-8000-00000000000a", // task keys
      "bbbb0000-0000-4000-8000-00000000000b", "aaaa0000-0000-4000-8000-00000000000a", // conversation signals
    ]);
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
        sessionId: "cccc0000-0000-4000-8000-00000000000c", message: { role: "user", content: "task" },
      }),
      JSON.stringify({
        type: "assistant", timestamp: "2026-07-07T12:05:00.000Z", cwd: "/work/p0",
        sessionId: "cccc0000-0000-4000-8000-00000000000c", message: { role: "assistant", content: "done" },
      }),
    ].join("\n") + "\n");
    utimesSync(f, MTIME, MTIME);

    const config = defaultConfig();
    config.connectors.claudeCode.rootDir = ccRoot;
    config.connectors.codex.enabled = false;
    config.connectors.engram = { enabled: true, binaryPath: "/fake/engram", beadPrefixes: [] };

    const matchExec: Exec = async (argv) => {
      if (argv[1] === "grep" && argv[2] === "cccc0000-0000-4000-8000-00000000000c") {
        return {
          ok: true,
          stdout: JSON.stringify({ sessions: [{ session_id: "e1e1e1e1e1e1e1e1", confidence: 12.0 }] }),
          stderr: "",
        };
      }
      if (argv[1] === "peek" && argv[2] === "e1e1e1e1e1e1e1e1") {
        return {
          ok: true,
          stdout: JSON.stringify({
            session: {
              content: [{
                line: 1,
                text: JSON.stringify({
                  file: "/work/p0/src/app.ts", k: "code.edit",
                  source: { harness: "claude-code", session_id: "cccc0000-0000-4000-8000-00000000000c" }, t: "t",
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
    expect(agent.evidenceCitation).toContain("e1e1e1e1e1e1e1e1");
    expect(agent.evidenceCitation).toContain("/work/p0/src/app.ts");

    // Every failure path leaves the inferred level untouched.
    const failingExec: Exec = async () => ({ ok: false, stdout: "", stderr: "engram: not found" });
    const untouched = await buildReport({ since: SINCE, now: NOW, config, useLlm: false, engramExec: failingExec });
    const agent2 = untouched.agents.find((a) => a.workdir === "/work/p0")!;
    expect(agent2.evidence).toBe("claimed_only");
    expect(agent2.evidenceCitation).toBeUndefined();

    // Defense in depth (same contract as commit subjects / facts): the
    // citation is assembled from Engram-derived file paths, and a
    // secret-bearing path must be redacted at the model layer, not left for
    // the CLI's final render pass.
    config.redactPatterns = ["app\\.ts"];
    const redacted = await buildReport({ since: SINCE, now: NOW, config, useLlm: false, engramExec: matchExec });
    const agent3 = redacted.agents.find((a) => a.workdir === "/work/p0")!;
    expect(agent3.evidence).toBe("partially_proven");
    expect(agent3.evidenceCitation).toContain("[REDACTED]");
    expect(agent3.evidenceCitation).not.toContain("app.ts");
  });

  // End-to-end acceptance for asl-9pd: in-session subagent runs (Task-tool
  // dispatches, whose transcripts inherit the dispatching session's harness
  // id) land on the orchestrator's card as a run count and render.
  test("in-session subagent runs attach to the orchestrator profile as dispatchedRuns and render", async () => {
    const ORCH = "aaaa0000-0000-4000-8000-00000000000a";
    const RUN_TAPES = [
      "2222222222222222222222222222222222222222222222222222222222222222",
      "3333333333333333333333333333333333333333333333333333333333333333",
    ];

    const world = mkdtempSync(join(tmpdir(), "asl-report-"));
    const ccRoot = join(world, "claude-projects");
    const dir = join(ccRoot, "-work-orch");
    mkdirSync(dir, { recursive: true });
    const f = join(dir, "s.jsonl");
    writeFileSync(f, [
      JSON.stringify({
        type: "user", timestamp: "2026-07-07T12:00:00.000Z", cwd: "/work/orch",
        sessionId: ORCH, message: { role: "user", content: "task" },
      }),
      JSON.stringify({
        type: "assistant", timestamp: "2026-07-07T12:05:00.000Z", cwd: "/work/orch",
        sessionId: ORCH, message: { role: "assistant", content: "done" },
      }),
    ].join("\n") + "\n");
    utimesSync(f, MTIME, MTIME);

    const config = defaultConfig();
    config.connectors.claudeCode.rootDir = ccRoot;
    config.connectors.codex.enabled = false;
    config.connectors.engram = { enabled: true, binaryPath: "/fake/engram", beadPrefixes: [] };

    // Each run's tape carries a marker-prefixed msg.in owned by the
    // orchestrator's own uuid (Task transcripts inherit it) at a distinct
    // timestamp — two tapes, two runs.
    const exec: Exec = async (argv) => {
      if (argv[1] === "grep" && argv[2] === markerQuery(ORCH)) {
        return {
          ok: true,
          stdout: JSON.stringify({
            total: 2,
            sessions: RUN_TAPES.map((session_id) => ({ session_id, confidence: 1.0 })),
          }),
          stderr: "",
        };
      }
      if (argv[1] === "peek" && RUN_TAPES.includes(argv[2]!)) {
        return {
          ok: true,
          stdout: JSON.stringify({
            session: {
              content: [{
                line: 1,
                text: JSON.stringify({
                  k: "msg.in", role: "user",
                  content: `<engram-src id="${ORCH}"/> implement the thing`,
                  source: { harness: "claude-code", session_id: ORCH },
                  t: `2026-07-07T12:0${RUN_TAPES.indexOf(argv[2]!)}:30.000Z`,
                }),
              }],
            },
          }),
          stderr: "",
        };
      }
      return { ok: true, stdout: JSON.stringify({ error: "no_results" }), stderr: "" };
    };

    const report = await buildReport({ since: SINCE, now: NOW, config, useLlm: false, engramExec: exec });
    const orch = report.agents.find((a) => a.workdir === "/work/orch")!;
    expect(orch.dispatchedRuns).toBe(2);
    expect(orch.dispatched).toBeUndefined();
    expect(orch.dispatchedBy).toBeUndefined();
    expect(orch.dispatchTruncated).toBeUndefined();

    const { renderMarkdown } = await import("../src/render/markdown");
    const md = renderMarkdown(report);
    expect(md).toContain("- Dispatched 2 subagent runs: 2 in-session runs");
  });

  // End-to-end acceptance for asl-69s: two sessions linked by an engram
  // dispatch marker end up cross-referenced in the report — the orchestrator
  // card says what it dispatched, the subagent card says who dispatched it,
  // and both renderers show the relationship.
  test("dispatch-marker lineage cross-references orchestrator and subagent profiles in the report and renders", async () => {
    const ORCH = "aaaa0000-0000-4000-8000-00000000000a";
    const SUB = "bbbb0000-0000-4000-8000-00000000000b";
    const CHILD_TAPE = "2222222222222222222222222222222222222222222222222222222222222222";

    const world = mkdtempSync(join(tmpdir(), "asl-report-"));
    const ccRoot = join(world, "claude-projects");
    const mkSession = (dirName: string, cwd: string, sessionId: string) => {
      const dir = join(ccRoot, dirName);
      mkdirSync(dir, { recursive: true });
      const f = join(dir, "s.jsonl");
      writeFileSync(f, [
        JSON.stringify({
          type: "user", timestamp: "2026-07-07T12:00:00.000Z", cwd,
          sessionId, message: { role: "user", content: "task" },
        }),
        JSON.stringify({
          type: "assistant", timestamp: "2026-07-07T12:05:00.000Z", cwd,
          sessionId, message: { role: "assistant", content: "done" },
        }),
      ].join("\n") + "\n");
      utimesSync(f, MTIME, MTIME);
    };
    mkSession("-work-orch", "/work/orch", ORCH);
    mkSession("-work-sub", "/work/sub", SUB);

    const config = defaultConfig();
    config.connectors.claudeCode.rootDir = ccRoot;
    config.connectors.codex.enabled = false;
    config.connectors.engram = { enabled: true, binaryPath: "/fake/engram", beadPrefixes: [] };

    // Engram CLI double: grep on the orchestrator uuid finds the subagent's
    // tape; peeking that tape returns the subagent's first user message,
    // whose parsed content begins with the dispatch marker (the spec
    // prepends it to the handoff prompt) and carries the subagent's
    // source.session_id.
    const exec: Exec = async (argv) => {
      if (argv[1] === "grep" && argv[2] === markerQuery(ORCH)) {
        return {
          ok: true,
          stdout: JSON.stringify({ sessions: [{ session_id: CHILD_TAPE, confidence: 325.0 }] }),
          stderr: "",
        };
      }
      if (argv[1] === "peek" && argv[2] === CHILD_TAPE) {
        return {
          ok: true,
          stdout: JSON.stringify({
            session: {
              content: [{
                line: 1,
                text: JSON.stringify({
                  k: "msg.in", role: "user",
                  content: `<engram-src id="${ORCH}"/> implement the thing`,
                  source: { harness: "claude-code", session_id: SUB },
                  t: "2026-07-07T12:00:01.000Z",
                }),
              }],
            },
          }),
          stderr: "",
        };
      }
      return { ok: true, stdout: JSON.stringify({ error: "no_results" }), stderr: "" };
    };

    const report = await buildReport({ since: SINCE, now: NOW, config, useLlm: false, engramExec: exec });
    const orch = report.agents.find((a) => a.workdir === "/work/orch")!;
    const sub = report.agents.find((a) => a.workdir === "/work/sub")!;

    expect(orch.dispatched).toEqual([{ sessionId: SUB, profile: "sub (claude-code)" }]);
    expect(orch.dispatchedBy).toBeUndefined();
    expect(sub.dispatchedBy).toEqual([{ sessionId: ORCH, profile: "orch (claude-code)" }]);
    expect(sub.dispatched).toBeUndefined();

    // The relationship is visible in the rendered surfaces.
    const { renderMarkdown } = await import("../src/render/markdown");
    const { renderHtml } = await import("../src/render/html");
    const { renderJson } = await import("../src/render/json");
    const md = renderMarkdown(report);
    expect(md).toContain("- Dispatched 1 subagent run: sub (claude-code) (session bbbb0000)");
    expect(md).toContain("- Dispatched by: orch (claude-code) (session aaaa0000)");
    const html = renderHtml(report);
    expect(html).toContain(`<dt>Dispatched</dt><dd class="dispatch">1 subagent run: sub (claude-code) (session bbbb0000)</dd>`);
    expect(html).toContain(`<dt>Dispatched by</dt><dd class="dispatch">orch (claude-code) (session aaaa0000)</dd>`);
    expect(JSON.parse(renderJson(report)).agents.some(
      (a: { dispatched?: unknown[] }) => Array.isArray(a.dispatched))).toBe(true);
  });

  // Invariant: lineage is resolved against the POST-filter profile set, so
  // every rendered DispatchRef's counterpart has a card in the report. An
  // edge whose other end was filtered as trivial is dropped, not dangled.
  test("dispatch lineage never names a trivial-filtered counterpart (both directions)", async () => {
    const ORCH = "aaaa0000-0000-4000-8000-00000000000a";
    const SUB = "bbbb0000-0000-4000-8000-00000000000b";
    const CHILD_TAPE = "2222222222222222222222222222222222222222222222222222222222222222";

    // engram double that would happily link ORCH → SUB if asked
    const exec: Exec = async (argv) => {
      if (argv[1] === "grep" && argv[2] === markerQuery(ORCH)) {
        return {
          ok: true,
          stdout: JSON.stringify({ sessions: [{ session_id: CHILD_TAPE, confidence: 325.0 }] }),
          stderr: "",
        };
      }
      if (argv[1] === "peek" && argv[2] === CHILD_TAPE) {
        return {
          ok: true,
          stdout: JSON.stringify({
            session: {
              content: [{
                line: 1,
                text: JSON.stringify({
                  k: "msg.in", role: "user",
                  content: `<engram-src id="${ORCH}"/> implement the thing`,
                  source: { harness: "claude-code", session_id: SUB },
                  t: "2026-07-07T12:00:01.000Z",
                }),
              }],
            },
          }),
          stderr: "",
        };
      }
      return { ok: true, stdout: JSON.stringify({ error: "no_results" }), stderr: "" };
    };

    const buildWorld = (trivialId: string) => {
      const world = mkdtempSync(join(tmpdir(), "asl-report-"));
      const ccRoot = join(world, "claude-projects");
      const mkSession = (dirName: string, cwd: string, sessionId: string, minutes: number) => {
        const dir = join(ccRoot, dirName);
        mkdirSync(dir, { recursive: true });
        const f = join(dir, "s.jsonl");
        writeFileSync(f, [
          JSON.stringify({
            type: "user", timestamp: "2026-07-07T12:00:00.000Z", cwd,
            sessionId, message: { role: "user", content: "task" },
          }),
          JSON.stringify({
            type: "assistant", timestamp: `2026-07-07T12:0${minutes}:${minutes ? "00" : "10"}.000Z`, cwd,
            sessionId, message: { role: "assistant", content: "done" },
          }),
        ].join("\n") + "\n");
        utimesSync(f, MTIME, MTIME);
      };
      // 10-second session → trivial; 5-minute session → real card
      mkSession("-work-orch", "/work/orch", ORCH, trivialId === ORCH ? 0 : 5);
      mkSession("-work-sub", "/work/sub", SUB, trivialId === SUB ? 0 : 5);
      const config = defaultConfig();
      config.connectors.claudeCode.rootDir = ccRoot;
      config.connectors.codex.enabled = false;
      config.connectors.engram = { enabled: true, binaryPath: "/fake/engram", beadPrefixes: [] };
      return config;
    };

    // Direction 1: trivial PARENT — the subagent card must not claim it was
    // dispatched by a profile that has no card.
    const trivialParent = await buildReport({
      since: SINCE, now: NOW, config: buildWorld(ORCH), useLlm: false, engramExec: exec,
    });
    expect(trivialParent.trivialProfiles).toEqual(["orch (claude-code)"]);
    const sub1 = trivialParent.agents.find((a) => a.workdir === "/work/sub")!;
    expect(sub1.dispatchedBy).toBeUndefined();

    // Direction 2: trivial CHILD — the orchestrator card must not list a
    // dispatched run that has no card.
    const trivialChild = await buildReport({
      since: SINCE, now: NOW, config: buildWorld(SUB), useLlm: false, engramExec: exec,
    });
    expect(trivialChild.trivialProfiles).toEqual(["sub (claude-code)"]);
    const orch2 = trivialChild.agents.find((a) => a.workdir === "/work/orch")!;
    expect(orch2.dispatched).toBeUndefined();
  });

  // Product honesty: when the lineage probe hit its candidate cap for a
  // parent, that parent's card carries dispatchTruncated so renderers can
  // say "list may be incomplete" instead of presenting a partial list as
  // the whole truth.
  test("dispatchTruncated lands on the truncated parent's card, and only there", async () => {
    const ORCH = "aaaa0000-0000-4000-8000-00000000000a";
    const SUB = "bbbb0000-0000-4000-8000-00000000000b";
    const CHILD_TAPE = "2222222222222222222222222222222222222222222222222222222222222222";
    // grep reports 17 marker tapes index-wide but returns fewer than the
    // 16-tape cap → ORCH's discovered lineage may be an undercount
    const NOISE_TAPES = Array.from({ length: 7 }, (_, i) => String(i + 3).repeat(64));
    const GREP_TOTAL = 17;

    const world = mkdtempSync(join(tmpdir(), "asl-report-"));
    const ccRoot = join(world, "claude-projects");
    const mkSession = (dirName: string, cwd: string, sessionId: string) => {
      const dir = join(ccRoot, dirName);
      mkdirSync(dir, { recursive: true });
      const f = join(dir, "s.jsonl");
      writeFileSync(f, [
        JSON.stringify({
          type: "user", timestamp: "2026-07-07T12:00:00.000Z", cwd,
          sessionId, message: { role: "user", content: "task" },
        }),
        JSON.stringify({
          type: "assistant", timestamp: "2026-07-07T12:05:00.000Z", cwd,
          sessionId, message: { role: "assistant", content: "done" },
        }),
      ].join("\n") + "\n");
      utimesSync(f, MTIME, MTIME);
    };
    mkSession("-work-orch", "/work/orch", ORCH);
    mkSession("-work-sub", "/work/sub", SUB);

    const config = defaultConfig();
    config.connectors.claudeCode.rootDir = ccRoot;
    config.connectors.codex.enabled = false;
    config.connectors.engram = { enabled: true, binaryPath: "/fake/engram", beadPrefixes: [] };

    const exec: Exec = async (argv) => {
      if (argv[1] === "grep" && argv[2] === markerQuery(ORCH)) {
        return {
          ok: true,
          stdout: JSON.stringify({
            total: GREP_TOTAL,
            sessions: [CHILD_TAPE, ...NOISE_TAPES].map((session_id) => ({ session_id, confidence: 325.0 })),
          }),
          stderr: "",
        };
      }
      if (argv[1] === "peek" && argv[2] === CHILD_TAPE) {
        return {
          ok: true,
          stdout: JSON.stringify({
            session: {
              content: [{
                line: 1,
                text: JSON.stringify({
                  k: "msg.in", role: "user",
                  content: `<engram-src id="${ORCH}"/> implement the thing`,
                  source: { harness: "claude-code", session_id: SUB },
                  t: "2026-07-07T12:00:01.000Z",
                }),
              }],
            },
          }),
          stderr: "",
        };
      }
      if (argv[1] === "peek") {
        return { ok: true, stdout: JSON.stringify({ session: { content: [] } }), stderr: "" };
      }
      return { ok: true, stdout: JSON.stringify({ error: "no_results" }), stderr: "" };
    };

    const report = await buildReport({ since: SINCE, now: NOW, config, useLlm: false, engramExec: exec });
    const orch = report.agents.find((a) => a.workdir === "/work/orch")!;
    const sub = report.agents.find((a) => a.workdir === "/work/sub")!;
    expect(orch.dispatched).toEqual([{ sessionId: SUB, profile: "sub (claude-code)" }]);
    expect(orch.dispatchTruncated).toBe(true);
    expect(sub.dispatchTruncated).toBeUndefined();

    const { renderMarkdown } = await import("../src/render/markdown");
    const md = renderMarkdown(report);
    expect(md).toContain("- Dispatched 1 subagent run: sub (claude-code) (session bbbb0000) (list may be incomplete)");
  });
  // asl-1wm acceptance: two sessions that both mention a task key (bead ID
  // in dialogue, via engram) and edit overlapping files render as ONE task
  // thread with both sessions in order and their evidence; a session
  // matching no thread still reports exactly as today.
  test("task threads: sessions sharing a bead key form one thread; unmatched sessions still get cards", async () => {
    const S_A = "aaaa0000-0000-4000-8000-00000000000a";
    const S_B = "bbbb0000-0000-4000-8000-00000000000b";
    const S_C = "cccc0000-0000-4000-8000-00000000000c";
    const TAPE_A = "1111111111111111111111111111111111111111111111111111111111111111";
    const TAPE_B = "2222222222222222222222222222222222222222222222222222222222222222";

    const world = mkdtempSync(join(tmpdir(), "asl-report-"));
    const ccRoot = join(world, "claude-projects");
    const mkSession = (dirName: string, cwd: string, sessionId: string, hour: string, files: string[]) => {
      const dir = join(ccRoot, dirName);
      mkdirSync(dir, { recursive: true });
      const f = join(dir, "s.jsonl");
      writeFileSync(f, [
        JSON.stringify({
          type: "user", timestamp: `2026-07-07T${hour}:00:00.000Z`, cwd,
          sessionId, message: { role: "user", content: "task" },
        }),
        JSON.stringify({
          type: "file-history-snapshot", timestamp: `2026-07-07T${hour}:01:00.000Z`, cwd, sessionId,
          snapshot: { trackedFileBackups: Object.fromEntries(files.map((p) => [p, {}])) },
        }),
        JSON.stringify({
          type: "assistant", timestamp: `2026-07-07T${hour}:05:00.000Z`, cwd,
          sessionId, message: { role: "assistant", content: "done" },
        }),
      ].join("\n") + "\n");
      utimesSync(f, MTIME, MTIME);
    };
    // Both thread members edit overlapping files; the bystander touches
    // unrelated files and mentions no key.
    mkSession("-work-one", "/work/one", S_A, "12", ["/repo/src/x.ts", "/repo/src/y.ts"]);
    mkSession("-work-two", "/work/two", S_B, "09", ["/repo/src/x.ts"]);
    mkSession("-work-three", "/work/three", S_C, "10", ["/elsewhere/z.ts"]);

    const config = defaultConfig();
    config.connectors.claudeCode.rootDir = ccRoot;
    config.connectors.codex.enabled = false;
    config.connectors.engram = { enabled: true, binaryPath: "/fake/engram", beadPrefixes: ["asl"] };

    // Engram double: the bare-uuid grep finds each thread member's own tape;
    // peeking it with the message filter returns dialogue mentioning the
    // bead. The code.edit (evidence) peeks find nothing, marker-literal
    // (lineage) greps find nothing, and S_C's dialogue mentions no key.
    const tapeByUuid: Record<string, string> = { [S_A]: TAPE_A, [S_B]: TAPE_B };
    const uuidByTape: Record<string, string> = { [TAPE_A]: S_A, [TAPE_B]: S_B };
    const exec: Exec = async (argv) => {
      if (argv[1] === "grep" && tapeByUuid[argv[2]!]) {
        return {
          ok: true,
          stdout: JSON.stringify({ sessions: [{ session_id: tapeByUuid[argv[2]!], confidence: 325.0 }] }),
          stderr: "",
        };
      }
      if (argv[1] === "peek" && argv[4] === '"k":"msg.' && uuidByTape[argv[2]!]) {
        return {
          ok: true,
          stdout: JSON.stringify({
            session: {
              content: [{
                line: 1,
                text: JSON.stringify({
                  k: "msg.in", role: "user",
                  content: "please pick up bead asl-1wm where the last session left off",
                  source: { harness: "claude-code", session_id: uuidByTape[argv[2]!] },
                  t: "2026-07-07T12:00:01.000Z",
                }),
              }],
            },
          }),
          stderr: "",
        };
      }
      if (argv[1] === "peek") {
        return { ok: true, stdout: JSON.stringify({ session: { content: [] } }), stderr: "" };
      }
      return { ok: true, stdout: JSON.stringify({ error: "no_results" }), stderr: "" };
    };

    const report = await buildReport({ since: SINCE, now: NOW, config, useLlm: false, engramExec: exec });

    // one thread, both member sessions in startedAt order, with evidence counts
    expect(report.threads).toHaveLength(1);
    const t = report.threads![0]!;
    expect(t.threadKey).toBe("asl-1wm");
    expect(t.source).toBe("bead");
    expect(t.sessions.map((s) => s.sessionId)).toEqual([S_B, S_A]);
    expect(t.sessions.map((s) => s.profile)).toEqual(["two (claude-code)", "one (claude-code)"]);
    expect(t.sessions.map((s) => s.files)).toEqual([1, 2]);

    // the unmatched session reports exactly as today: a card, no thread
    expect(report.agents).toHaveLength(3);
    const bystander = report.agents.find((a) => a.workdir === "/work/three")!;
    expect(bystander).toBeDefined();
    expect(t.sessions.some((s) => s.sessionId === S_C)).toBe(false);

    // the thread is visible in every rendered surface
    const { renderMarkdown } = await import("../src/render/markdown");
    const { renderHtml } = await import("../src/render/html");
    const { renderJson } = await import("../src/render/json");
    const md = renderMarkdown(report);
    expect(md).toContain("## Task threads");
    expect(md).toContain("### asl-1wm — idle, 2 sessions");
    expect(md).toContain("- 2026-07-07T09:00:00.000Z — two (claude-code) (session bbbb0000): 1 file, 0 commits");
    expect(md).toContain("- 2026-07-07T12:00:00.000Z — one (claude-code) (session aaaa0000): 2 files, 0 commits");
    expect(renderHtml(report)).toContain("<h2>Task threads</h2>");
    expect(JSON.parse(renderJson(report)).threads[0].threadKey).toBe("asl-1wm");
  });

  // Fail-soft degradation (PRD §10): with engram disabled, bead keys are
  // unavailable but file-cluster correlation from parsed session data still
  // threads; with engram failing outright, the report never breaks.
  test("task threads degrade gracefully: file clusters without engram, clean report on engram failure", async () => {
    const S_A = "aaaa0000-0000-4000-8000-00000000000a";
    const S_B = "bbbb0000-0000-4000-8000-00000000000b";
    const world = mkdtempSync(join(tmpdir(), "asl-report-"));
    const ccRoot = join(world, "claude-projects");
    const mkSession = (dirName: string, cwd: string, sessionId: string, hour: string, files: string[]) => {
      const dir = join(ccRoot, dirName);
      mkdirSync(dir, { recursive: true });
      const f = join(dir, "s.jsonl");
      writeFileSync(f, [
        JSON.stringify({
          type: "user", timestamp: `2026-07-07T${hour}:00:00.000Z`, cwd,
          sessionId, message: { role: "user", content: "task" },
        }),
        JSON.stringify({
          type: "file-history-snapshot", timestamp: `2026-07-07T${hour}:01:00.000Z`, cwd, sessionId,
          snapshot: { trackedFileBackups: Object.fromEntries(files.map((p) => [p, {}])) },
        }),
        JSON.stringify({
          type: "assistant", timestamp: `2026-07-07T${hour}:05:00.000Z`, cwd,
          sessionId, message: { role: "assistant", content: "done" },
        }),
      ].join("\n") + "\n");
      utimesSync(f, MTIME, MTIME);
    };
    const shared = ["/repo/src/x.ts", "/repo/src/y.ts"];
    mkSession("-work-one", "/work/one", S_A, "09", shared);
    mkSession("-work-two", "/work/two", S_B, "12", [...shared, "/repo/src/z.ts"]);

    const config = defaultConfig();
    config.connectors.claudeCode.rootDir = ccRoot;
    config.connectors.codex.enabled = false;

    // engram disabled (default): file-cluster fallback threads the overlap
    const disabled = await buildReport({ since: SINCE, now: NOW, config, useLlm: false });
    expect(disabled.threads).toHaveLength(1);
    expect(disabled.threads![0]!.source).toBe("files");
    expect(disabled.threads![0]!.threadKey).toBe("files:/repo/src/x.ts");
    expect(disabled.threads![0]!.sessions.map((s) => s.sessionId)).toEqual([S_A, S_B]);

    // engram enabled but broken: identical thread outcome, report intact
    config.connectors.engram = { enabled: true, binaryPath: "/fake/engram", beadPrefixes: ["asl"] };
    const failingExec: Exec = async () => ({ ok: false, stdout: "", stderr: "engram: not found" });
    const broken = await buildReport({ since: SINCE, now: NOW, config, useLlm: false, engramExec: failingExec });
    expect(broken.agents).toHaveLength(2);
    expect(broken.threads).toHaveLength(1);
    expect(broken.threads![0]!.source).toBe("files");
  });

  // asl-cey acceptance 1: a thinking-help session is labeled distinctly from
  // a build session in report output — a pure conversation must not be
  // reported like a build run.
  test("conversation signals: a thinking-help profile is labeled distinctly from a build profile in the report", async () => {
    const THINK = "aaaa0000-0000-4000-8000-00000000000a";
    const BUILD = "bbbb0000-0000-4000-8000-00000000000b";
    const THINK_TAPE = "1111111111111111111111111111111111111111111111111111111111111111";
    const BUILD_TAPE = "2222222222222222222222222222222222222222222222222222222222222222";

    const world = mkdtempSync(join(tmpdir(), "asl-report-"));
    const ccRoot = join(world, "claude-projects");
    const mkSession = (dirName: string, cwd: string, sessionId: string) => {
      const dir = join(ccRoot, dirName);
      mkdirSync(dir, { recursive: true });
      const f = join(dir, "s.jsonl");
      writeFileSync(f, [
        JSON.stringify({
          type: "user", timestamp: "2026-07-07T12:00:00.000Z", cwd,
          sessionId, message: { role: "user", content: "task" },
        }),
        JSON.stringify({
          type: "assistant", timestamp: "2026-07-07T12:05:00.000Z", cwd,
          sessionId, message: { role: "assistant", content: "done" },
        }),
      ].join("\n") + "\n");
      utimesSync(f, MTIME, MTIME);
    };
    mkSession("-work-think", "/work/think", THINK);
    mkSession("-work-build", "/work/build", BUILD);

    const config = defaultConfig();
    config.connectors.claudeCode.rootDir = ccRoot;
    config.connectors.codex.enabled = false;
    config.connectors.engram = { enabled: true, binaryPath: "/fake/engram", beadPrefixes: [] };

    // Engram double: THINK's tape is pure dialogue; BUILD's tape carries a
    // code.edit. Both owned by their respective sessions.
    const tapeByUuid: Record<string, string> = { [THINK]: THINK_TAPE, [BUILD]: BUILD_TAPE };
    const exec: Exec = async (argv) => {
      if (argv[1] === "grep" && tapeByUuid[argv[2]!]) {
        return {
          ok: true,
          stdout: JSON.stringify({ sessions: [{ session_id: tapeByUuid[argv[2]!], confidence: 325.0 }] }),
          stderr: "",
        };
      }
      if (argv[1] === "peek" && argv[4] === '"k":"') {
        const events =
          argv[2] === THINK_TAPE
            ? [
                { k: "msg.in", content: "how should we shape the migration?", source: { session_id: THINK }, t: "2026-07-07T12:00:01.000Z" },
                { k: "msg.out", content: "two viable options, tradeoffs are...", source: { session_id: THINK }, t: "2026-07-07T12:01:00.000Z" },
              ]
            : [
                { k: "msg.in", content: "fix the bug", source: { session_id: BUILD }, t: "2026-07-07T12:00:01.000Z" },
                { k: "code.edit", file: "/work/build/src/a.ts", source: { session_id: BUILD }, t: "2026-07-07T12:02:00.000Z" },
              ];
        return {
          ok: true,
          stdout: JSON.stringify({
            session: { content: events.map((ev, i) => ({ line: i + 1, text: JSON.stringify(ev) })) },
          }),
          stderr: "",
        };
      }
      if (argv[1] === "peek") return { ok: true, stdout: JSON.stringify({ session: { content: [] } }), stderr: "" };
      return { ok: true, stdout: JSON.stringify({ error: "no_results" }), stderr: "" };
    };

    const report = await buildReport({ since: SINCE, now: NOW, config, useLlm: false, engramExec: exec });
    const think = report.agents.find((a) => a.workdir === "/work/think")!;
    const build = report.agents.find((a) => a.workdir === "/work/build")!;
    expect(think.interactionKind).toBe("thinking");
    expect(build.interactionKind).toBe("build");

    const { renderMarkdown } = await import("../src/render/markdown");
    const md = renderMarkdown(report);
    expect(md).toContain("- Session kind: thinking help (dialogue only, no build activity observed)");
    expect(md).toContain("- Session kind: build work (code edits or tool activity observed in dialogue)");
  });

  // asl-cey acceptance 2: an awaiting_user run's report section includes the
  // agent's final question, redacted — the decision being waited on, not
  // just a needs_human flag.
  test("conversation signals: an awaiting-user run's card quotes the agent's final question, redacted", async () => {
    const S = "aaaa0000-0000-4000-8000-00000000000a";
    const TAPE = "1111111111111111111111111111111111111111111111111111111111111111";
    const SECRET = "sk-fixturesecret1234567890abcdef";

    const world = mkdtempSync(join(tmpdir(), "asl-report-"));
    const ccRoot = join(world, "claude-projects");
    const dir = join(ccRoot, "-work-p0");
    mkdirSync(dir, { recursive: true });
    const f = join(dir, "s.jsonl");
    // Ends on a plain assistant reply → the connector marks awaitingUser.
    writeFileSync(f, [
      JSON.stringify({
        type: "user", timestamp: "2026-07-07T12:00:00.000Z", cwd: "/work/p0",
        sessionId: S, message: { role: "user", content: "task" },
      }),
      JSON.stringify({
        type: "assistant", timestamp: "2026-07-07T12:05:00.000Z", cwd: "/work/p0",
        sessionId: S, message: { role: "assistant", content: "which option?" },
      }),
    ].join("\n") + "\n");
    utimesSync(f, MTIME, MTIME);

    const config = defaultConfig();
    config.connectors.claudeCode.rootDir = ccRoot;
    config.connectors.codex.enabled = false;
    config.connectors.engram = { enabled: true, binaryPath: "/fake/engram", beadPrefixes: [] };

    const exec: Exec = async (argv) => {
      if (argv[1] === "grep" && argv[2] === S) {
        return {
          ok: true,
          stdout: JSON.stringify({ sessions: [{ session_id: TAPE, confidence: 325.0 }] }),
          stderr: "",
        };
      }
      if (argv[1] === "peek" && argv[2] === TAPE && argv[4] === '"k":"') {
        const events = [
          { k: "msg.in", content: "rotate the key", source: { session_id: S }, t: "2026-07-07T12:00:01.000Z" },
          {
            k: "msg.out",
            content: `The old key ${SECRET} is still referenced in two configs. Should I revoke it now or after the deploy?`,
            source: { session_id: S },
            t: "2026-07-07T12:05:00.000Z",
          },
        ];
        return {
          ok: true,
          stdout: JSON.stringify({
            session: { content: events.map((ev, i) => ({ line: i + 1, text: JSON.stringify(ev) })) },
          }),
          stderr: "",
        };
      }
      if (argv[1] === "peek") return { ok: true, stdout: JSON.stringify({ session: { content: [] } }), stderr: "" };
      return { ok: true, stdout: JSON.stringify({ error: "no_results" }), stderr: "" };
    };

    const report = await buildReport({ since: SINCE, now: NOW, config, useLlm: false, engramExec: exec });
    const agent = report.agents.find((a) => a.workdir === "/work/p0")!;
    expect(agent.awaitingQuestion).toBeDefined();
    expect(agent.awaitingQuestion!).toContain("Should I revoke it now or after the deploy?");
    expect(agent.awaitingQuestion!).not.toContain(SECRET);

    const { renderMarkdown } = await import("../src/render/markdown");
    const { renderHtml } = await import("../src/render/html");
    const md = renderMarkdown(report);
    expect(md).toContain("- Waiting on: “Should I revoke it now or after the deploy?”");
    expect(md).not.toContain(SECRET);
    const html = renderHtml(report);
    expect(html).toContain('class="awaiting-question"');
    expect(html).not.toContain(SECRET);
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
