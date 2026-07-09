import type { Commit, CommitEvidence } from "./types";
import { toUtcIso } from "./time";

export async function listCommits(repoDir: string, since: Date): Promise<Commit[]> {
  try {
    const proc = Bun.spawn(
      ["git", "-C", repoDir, "log", `--since=${since.toISOString()}`, "--pretty=format:%H%x09%aI%x09%s"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return [];
    return out
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
