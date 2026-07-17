import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attributeCommits, listCommits } from "../src/git";
import type { Exec } from "../src/exec";
import type { Commit } from "../src/types";

async function run(cwd: string, cmd: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(`${cmd.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
}

async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "asl-git-"));
  await run(dir, ["git", "init", "-q"]);
  await run(dir, ["git", "config", "user.email", "t@t.test"]);
  await run(dir, ["git", "config", "user.name", "t"]);
  return dir;
}

async function commitAt(dir: string, msg: string, isoDate: string) {
  await run(dir, ["git", "commit", "-q", "--allow-empty", "-m", msg], {
    GIT_AUTHOR_DATE: isoDate,
    GIT_COMMITTER_DATE: isoDate,
  });
}

describe("git correlator", () => {
  test("listCommits returns commits since the window start, newest first", async () => {
    const dir = await makeRepo();
    await commitAt(dir, "old commit", "2026-07-01T10:00:00Z");
    await commitAt(dir, "in-window commit", "2026-07-07T10:00:00Z");
    const commits = await listCommits(dir, new Date("2026-07-06T00:00:00Z"));
    expect(commits.length).toBe(1);
    expect(commits[0]!.subject).toBe("in-window commit");
    expect(commits[0]!.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  test("non-repo directory returns empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "asl-notrepo-"));
    expect(await listCommits(dir, new Date(0))).toEqual([]);
  });

  test("listCommits runs git log through the injected exec seam", async () => {
    const calls: string[][] = [];
    const fakeExec: Exec = async (argv) => {
      calls.push(argv);
      return {
        ok: true,
        stdout: `${"a".repeat(40)}\t2026-07-07T10:00:00+02:00\tsubject with\ttab\n${"b".repeat(40)}\t2026-07-06T09:00:00Z\tplain subject\n`,
        stderr: "",
      };
    };
    const since = new Date("2026-07-06T00:00:00Z");
    const commits = await listCommits("/some/repo", since, fakeExec);
    expect(calls).toEqual([
      ["git", "-C", "/some/repo", "log", `--since=${since.toISOString()}`, "--pretty=format:%H%x09%aI%x09%s"],
    ]);
    expect(commits).toEqual([
      // %aI offsets normalize to UTC; tabs inside a subject are rejoined.
      { sha: "a".repeat(40), authorDate: "2026-07-07T08:00:00.000Z", subject: "subject with\ttab" },
      { sha: "b".repeat(40), authorDate: "2026-07-06T09:00:00.000Z", subject: "plain subject" },
    ]);
  });

  test("listCommits returns empty when the exec seam reports failure", async () => {
    const failExec: Exec = async () => ({ ok: false, stdout: "garbage that must not be parsed\n", stderr: "fatal: not a git repository" });
    expect(await listCommits("/not/a/repo", new Date(0), failExec)).toEqual([]);
  });

  test("listCommits returns empty when the injected exec throws", async () => {
    const throwingExec: Exec = async () => {
      throw new Error("boom");
    };
    expect(await listCommits("/some/repo", new Date(0), throwingExec)).toEqual([]);
  });

  test("attribution: inside run window attributed, outside (human commit) not", () => {
    const commits: Commit[] = [
      { sha: "a".repeat(40), authorDate: "2026-07-07T10:30:00.000Z", subject: "agent work" },
      { sha: "b".repeat(40), authorDate: "2026-07-07T14:00:00.000Z", subject: "human hotfix" },
      { sha: "c".repeat(40), authorDate: "2026-07-07T11:03:00.000Z", subject: "agent commit in grace period" },
    ];
    const windows = [{ startedAt: "2026-07-07T10:00:00.000Z", lastEventAt: "2026-07-07T11:00:00.000Z" }];
    const evidence = attributeCommits(commits, windows);
    expect(evidence.find((c) => c.subject === "agent work")!.attributed).toBe(true);
    expect(evidence.find((c) => c.subject === "human hotfix")!.attributed).toBe(false);
    expect(evidence.find((c) => c.subject === "agent commit in grace period")!.attributed).toBe(true);
  });
});
