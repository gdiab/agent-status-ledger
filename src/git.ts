import type { Commit, CommitEvidence } from "./types";
import { makeSpawnExec, type Exec } from "./exec";
import { toUtcIso } from "./time";

// Bound for `git log`: local-disk repos answer in well under a second, but
// the failure this seam exists for is a repo on a hung network mount, where
// an unbounded child would stall the unattended morning run forever. 30s is
// generous for any legitimately slow (huge/cold-cache) repo while still
// letting the run degrade to "no commits" and move on.
export const GIT_TIMEOUT_MS = 30_000;

export async function listCommits(repoDir: string, since: Date, exec?: Exec): Promise<Commit[]> {
  try {
    // No injected seam runs real git (same pattern as engram's
    // `opts.exec ?? makeSpawnExec(...)`); tests inject fakes.
    const realExec = exec ?? makeSpawnExec(GIT_TIMEOUT_MS);
    const { ok, stdout } = await realExec([
      "git", "-C", repoDir, "log", `--since=${since.toISOString()}`, "--pretty=format:%H%x09%aI%x09%s",
    ]);
    if (!ok) return [];
    return stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, authorDate, ...rest] = line.split("\t");
        // %aI is always parseable in practice; if it ever isn't, keeping the
        // raw string (degrading to attributed:false downstream) beats silently
        // dropping the commit from the report.
        return { sha: sha!, authorDate: toUtcIso(authorDate!) ?? authorDate!, subject: rest.join("\t") };
      });
  } catch {
    return [];
  }
}

const GRACE_MS = 5 * 60_000;

export function attributeCommits(
  commits: Commit[],
  windows: Array<{ startedAt: string; lastEventAt: string }>,
  graceMs: number = GRACE_MS,
): CommitEvidence[] {
  return commits.map((c) => {
    const t = Date.parse(c.authorDate);
    const attributed = windows.some(
      (w) => t >= Date.parse(w.startedAt) && t <= Date.parse(w.lastEventAt) + graceMs,
    );
    return { ...c, attributed };
  });
}
