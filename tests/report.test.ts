import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReport, isTrivialProfile } from "../src/report";
import { defaultConfig } from "../src/config";
import type { AgentProfile, CommitEvidence, RawSession } from "../src/types";
import type { Exec } from "../src/exec";

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
    config.connectors.engram = { enabled: true, binaryPath: "/fake/engram" };

    const calls: string[][] = [];
    const alwaysMatchExec: Exec = (argv) => {
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
    config.connectors.engram = { enabled: true, binaryPath: "/fake/engram" };

    const grepped: string[] = [];
    const spy: Exec = (argv) => {
      if (argv[1] === "grep") grepped.push(argv[2]!);
      return { ok: true, stdout: JSON.stringify({ error: "no_results" }), stderr: "" };
    };
    await buildReport({ since: SINCE, now: NOW, config, useLlm: false, engramExec: spy });
    // Newest first: recent sessions are the ones most likely to be in the
    // index and most relevant to today's report. Two engram passes share the
    // seam and both order newest-first: the per-profile evidence upgrade
    // (inside the profile loop), then the report-wide dispatch-lineage probe
    // over the post-filter profiles.
    expect(grepped).toEqual([
      "bbbb0000-0000-4000-8000-00000000000b", "aaaa0000-0000-4000-8000-00000000000a", // evidence
      "bbbb0000-0000-4000-8000-00000000000b", "aaaa0000-0000-4000-8000-00000000000a", // lineage
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
    config.connectors.engram = { enabled: true, binaryPath: "/fake/engram" };

    const matchExec: Exec = (argv) => {
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
    const failingExec: Exec = () => ({ ok: false, stdout: "", stderr: "engram: not found" });
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
    config.connectors.engram = { enabled: true, binaryPath: "/fake/engram" };

    // Engram CLI double: grep on the orchestrator uuid finds the subagent's
    // tape; peeking that tape returns the subagent's first user message,
    // whose raw tape line carries the dispatch marker (quotes JSON-escaped,
    // as the real CLI returns them) and the subagent's source.session_id.
    const exec: Exec = (argv) => {
      if (argv[1] === "grep" && argv[2] === ORCH) {
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
    const exec: Exec = (argv) => {
      if (argv[1] === "grep" && argv[2] === ORCH) {
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
      config.connectors.engram = { enabled: true, binaryPath: "/fake/engram" };
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
