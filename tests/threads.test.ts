import { describe, expect, test } from "bun:test";
import { deriveTaskThreads } from "../src/threads";
import type { AgentProfile, AgentReport, CommitEvidence, RawSession } from "../src/types";

// Minimal model builders, same shapes as tests/report.test.ts.
function sess(over: Partial<RawSession>): RawSession {
  return {
    platform: "claude-code", sessionId: "s", cwd: "/w",
    startedAt: "2026-07-07T10:00:00.000Z", lastEventAt: "2026-07-07T10:30:00.000Z",
    events: [], filesTouched: [], errors: [],
    ...over,
  };
}

function prof(workdir: string, sessions: RawSession[]): AgentProfile {
  return {
    profileId: `claude-code:${workdir}`,
    platform: "claude-code",
    workdir,
    displayName: `${workdir.split("/").pop()} (claude-code)`,
    sessions,
  };
}

function agent(profile: AgentProfile, over: Partial<AgentReport> = {}): AgentReport {
  return {
    profileId: profile.profileId, displayName: profile.displayName,
    platform: profile.platform, workdir: profile.workdir,
    status: "completed", severity: "info", evidence: "claimed_only",
    facts: {
      titles: [], filesTouched: [], errors: [], commits: [], sessionCount: profile.sessions.length,
      firstActivity: "2026-07-07T10:00:00.000Z", lastActivity: "2026-07-07T10:30:00.000Z",
    },
    narrative: { workedOn: "w", completed: "c", inProgress: "i", blocked: "b", recommendation: "r", standup: "I did w." },
    narrativeSource: "template",
    commits: [],
    ...over,
  };
}

const keys = (pairs: [string, string[]][]) => new Map(pairs);

describe("deriveTaskThreads: bead keys", () => {
  test("two sessions sharing a bead key across profiles form one thread, ordered by startedAt", () => {
    const s1 = sess({ sessionId: "a1", cwd: "/work/one", startedAt: "2026-07-07T12:00:00.000Z", lastEventAt: "2026-07-07T12:30:00.000Z", filesTouched: ["/work/one/x.ts"] });
    const s2 = sess({ sessionId: "b1", cwd: "/work/two", startedAt: "2026-07-07T09:00:00.000Z", lastEventAt: "2026-07-07T09:30:00.000Z", errors: ["boom"] });
    const p1 = prof("/work/one", [s1]);
    const p2 = prof("/work/two", [s2]);
    const a1 = agent(p1);
    const a2 = agent(p2, { status: "blocked", severity: "warning", evidence: "proven" });

    const threads = deriveTaskThreads([a1, a2], [p1, p2], keys([["a1", ["asl-1wm"]], ["b1", ["asl-1wm"]]]), []);
    expect(threads).toHaveLength(1);
    const t = threads[0]!;
    expect(t.threadKey).toBe("asl-1wm");
    expect(t.source).toBe("bead");
    expect(t.title).toBe("asl-1wm");
    expect(t.sessions.map((s) => s.sessionId)).toEqual(["b1", "a1"]); // startedAt order, not input order
    expect(t.status).toBe("blocked");       // worst member status, exceptions-first
    expect(t.evidence).toBe("proven");      // strongest member evidence
    expect(t.firstActivityAt).toBe("2026-07-07T09:00:00.000Z");
    expect(t.lastActivityAt).toBe("2026-07-07T12:30:00.000Z");
    expect(t.workdir).toBeUndefined();      // members span two workdirs
    // evidence counts only, never content
    expect(t.sessions[1]).toEqual({
      sessionId: "a1", profile: "one (claude-code)", platform: "claude-code",
      startedAt: "2026-07-07T12:00:00.000Z", lastEventAt: "2026-07-07T12:30:00.000Z",
      files: 1, commits: 0, errors: 0,
    });
    expect(t.sessions[0]!.errors).toBe(1);
  });

  test("a bead key mentioned by a single session forms no thread", () => {
    const s1 = sess({ sessionId: "a1" });
    const p1 = prof("/w", [s1]);
    expect(deriveTaskThreads([agent(p1)], [p1], keys([["a1", ["asl-1wm"]]]), [])).toEqual([]);
  });

  test("a session mentioning two beads joins both threads; shared workdir is surfaced", () => {
    const mk = (id: string, hour: string) =>
      sess({ sessionId: id, startedAt: `2026-07-07T${hour}:00:00.000Z`, lastEventAt: `2026-07-07T${hour}:30:00.000Z` });
    const p = prof("/w", [mk("a1", "09"), mk("a2", "10"), mk("a3", "11")]);
    const a = agent(p);
    const threads = deriveTaskThreads(
      [a], [p],
      keys([["a1", ["asl-1wm"]], ["a2", ["asl-1wm", "asl-9pd"]], ["a3", ["asl-9pd"]]]),
      [],
    );
    expect(threads.map((t) => t.threadKey)).toEqual(["asl-9pd", "asl-1wm"]); // same status: recent activity first
    expect(threads.find((t) => t.threadKey === "asl-1wm")!.sessions.map((s) => s.sessionId)).toEqual(["a1", "a2"]);
    expect(threads.find((t) => t.threadKey === "asl-9pd")!.sessions.map((s) => s.sessionId)).toEqual(["a2", "a3"]);
    for (const t of threads) expect(t.workdir).toBe("/w");
  });

  test("attributed commits are counted per member session window, grace included", () => {
    const s1 = sess({ sessionId: "a1", startedAt: "2026-07-07T09:00:00.000Z", lastEventAt: "2026-07-07T09:30:00.000Z" });
    const s2 = sess({ sessionId: "a2", startedAt: "2026-07-07T12:00:00.000Z", lastEventAt: "2026-07-07T12:30:00.000Z" });
    const p = prof("/w", [s1, s2]);
    // Distinct shas per commit: commit identity is the sha, and exclusive
    // assignment dedupes on it — same-sha-different-date cannot occur.
    const commit = (sha: string, authorDate: string): CommitEvidence =>
      ({ sha: sha.repeat(40), authorDate, subject: "x", attributed: true });
    const a = agent(p, {
      commits: [
        commit("a", "2026-07-07T09:10:00.000Z"),   // inside a1
        commit("b", "2026-07-07T12:33:00.000Z"),   // 3 min after a2's last event: inside the grace window
        { ...commit("c", "2026-07-07T15:00:00.000Z"), attributed: false }, // outside both
      ],
    });
    const threads = deriveTaskThreads([a], [p], keys([["a1", ["asl-1wm"]], ["a2", ["asl-1wm"]]]), []);
    expect(threads[0]!.sessions.map((s) => s.commits)).toEqual([1, 1]);
  });

  test("a commit inside two overlapping member windows lands on exactly one member (earliest window)", () => {
    const s1 = sess({ sessionId: "a1", startedAt: "2026-07-07T09:00:00.000Z", lastEventAt: "2026-07-07T10:00:00.000Z" });
    const s2 = sess({ sessionId: "a2", startedAt: "2026-07-07T09:30:00.000Z", lastEventAt: "2026-07-07T10:30:00.000Z" });
    const p = prof("/w", [s1, s2]);
    const a = agent(p, {
      commits: [{ sha: "a".repeat(40), authorDate: "2026-07-07T09:45:00.000Z", subject: "x", attributed: true }],
    });
    const threads = deriveTaskThreads([a], [p], keys([["a1", ["asl-1wm"]], ["a2", ["asl-1wm"]]]), []);
    // 09:45 sits inside both windows; an honest thread total is 1, not 2,
    // and the deterministic owner is the earliest-starting member.
    expect(threads[0]!.sessions.map((s) => s.commits)).toEqual([1, 0]);
  });

  test("grace-created overlap does not double-count either: the grace window of an earlier member wins", () => {
    const s1 = sess({ sessionId: "a1", startedAt: "2026-07-07T09:00:00.000Z", lastEventAt: "2026-07-07T09:30:00.000Z" });
    const s2 = sess({ sessionId: "a2", startedAt: "2026-07-07T09:32:00.000Z", lastEventAt: "2026-07-07T10:00:00.000Z" });
    const p = prof("/w", [s1, s2]);
    const a = agent(p, {
      // 09:33 is within a1's 5-minute grace AND inside a2's window proper.
      commits: [{ sha: "b".repeat(40), authorDate: "2026-07-07T09:33:00.000Z", subject: "x", attributed: true }],
    });
    const threads = deriveTaskThreads([a], [p], keys([["a1", ["asl-1wm"]], ["a2", ["asl-1wm"]]]), []);
    expect(threads[0]!.sessions.map((s) => s.commits)).toEqual([1, 0]);
  });

  test("duplicate session ids (Task-tool transcripts inherit the parent id) count as one member", () => {
    const twin = sess({ sessionId: "a1" });
    const p = prof("/w", [twin, { ...twin, filesTouched: ["/w/other.ts"] }]);
    const a = agent(p);
    // both raw sessions carry the key; a single logical run must not
    // masquerade as a two-session thread
    expect(deriveTaskThreads([a], [p], keys([["a1", ["asl-1wm"]]]), [])).toEqual([]);
  });

  test("sessions of trivial-filtered profiles (no card) never join a thread", () => {
    const s1 = sess({ sessionId: "a1" });
    const s2 = sess({ sessionId: "b1" });
    const p1 = prof("/work/one", [s1]);
    const p2 = prof("/work/two", [s2]); // filtered: no agent card passed in
    const threads = deriveTaskThreads([agent(p1)], [p1, p2], keys([["a1", ["asl-1wm"]], ["b1", ["asl-1wm"]]]), []);
    expect(threads).toEqual([]);
  });
});

describe("deriveTaskThreads: file clusters", () => {
  test("two sessions sharing two files form a file thread; one shared file does not", () => {
    const shared = ["/repo/src/a.ts", "/repo/src/b.ts"];
    const s1 = sess({ sessionId: "a1", startedAt: "2026-07-07T09:00:00.000Z", filesTouched: [...shared, "/repo/src/only1.ts"] });
    const s2 = sess({ sessionId: "a2", startedAt: "2026-07-07T12:00:00.000Z", filesTouched: shared });
    const s3 = sess({ sessionId: "a3", filesTouched: ["/repo/src/a.ts", "/repo/src/z.ts"] }); // 1 shared file: out
    const p = prof("/repo", [s1, s2, s3]);
    const a = agent(p);
    const threads = deriveTaskThreads([a], [p], new Map(), []);
    expect(threads).toHaveLength(1);
    const t = threads[0]!;
    expect(t.source).toBe("files");
    expect(t.threadKey).toBe("files:/repo/src/a.ts"); // lexicographically-first shared file
    expect(t.title).toBe("a.ts, b.ts");
    expect(t.sessions.map((s) => s.sessionId)).toEqual(["a1", "a2"]);
  });

  test("file-cluster titles cap the basenames named", () => {
    const shared = ["/r/a.ts", "/r/b.ts", "/r/c.ts", "/r/d.ts"];
    const s1 = sess({ sessionId: "a1", startedAt: "2026-07-07T09:00:00.000Z", filesTouched: shared });
    const s2 = sess({ sessionId: "a2", startedAt: "2026-07-07T10:00:00.000Z", filesTouched: shared });
    const p = prof("/r", [s1, s2]);
    const threads = deriveTaskThreads([agent(p)], [p], new Map(), []);
    expect(threads[0]!.title).toBe("a.ts, b.ts +2 more");
  });

  test("bead-claimed sessions are excluded from file clustering (one thread per unit of work)", () => {
    const shared = ["/r/a.ts", "/r/b.ts"];
    const s1 = sess({ sessionId: "a1", startedAt: "2026-07-07T09:00:00.000Z", filesTouched: shared });
    const s2 = sess({ sessionId: "a2", startedAt: "2026-07-07T10:00:00.000Z", filesTouched: shared });
    const p = prof("/r", [s1, s2]);
    const a = agent(p);
    const threads = deriveTaskThreads([a], [p], keys([["a1", ["asl-1wm"]], ["a2", ["asl-1wm"]]]), []);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.source).toBe("bead");
  });

  test("file-derived keys and titles pass through redact (defense in depth)", () => {
    const shared = ["/r/hunter2secret-a.ts", "/r/hunter2secret-b.ts"];
    const s1 = sess({ sessionId: "a1", startedAt: "2026-07-07T09:00:00.000Z", filesTouched: shared });
    const s2 = sess({ sessionId: "a2", startedAt: "2026-07-07T10:00:00.000Z", filesTouched: shared });
    const p = prof("/r", [s1, s2]);
    const threads = deriveTaskThreads([agent(p)], [p], new Map(), ["hunter2secret"]);
    expect(threads[0]!.threadKey).toContain("[REDACTED]");
    expect(threads[0]!.title).toContain("[REDACTED]");
    expect(JSON.stringify(threads[0])).not.toContain("hunter2secret");
  });

  // Shared fixture for the ordering tests: one bead thread in /w1, one
  // file-cluster thread in /w2, with the file agent's status overridable.
  function beadAndFileThreads(fileAgentOver: Partial<AgentReport> = {}) {
    const shared = ["/r/a.ts", "/r/b.ts"];
    const bead1 = sess({ sessionId: "a1", cwd: "/w1", startedAt: "2026-07-07T09:00:00.000Z" });
    const bead2 = sess({ sessionId: "a2", cwd: "/w1", startedAt: "2026-07-07T10:00:00.000Z" });
    const file1 = sess({ sessionId: "b1", cwd: "/w2", startedAt: "2026-07-07T11:00:00.000Z", filesTouched: shared });
    const file2 = sess({ sessionId: "b2", cwd: "/w2", startedAt: "2026-07-07T12:00:00.000Z", filesTouched: shared });
    const p1 = prof("/w1", [bead1, bead2]);
    const p2 = prof("/w2", [file1, file2]);
    const a1 = agent(p1);
    const a2 = agent(p2, fileAgentOver);
    return deriveTaskThreads([a1, a2], [p1, p2], keys([["a1", ["asl-1wm"]], ["a2", ["asl-1wm"]]]), []);
  }

  test("worst status sorts first across sources: a failed file cluster leads a completed bead thread", () => {
    const threads = beadAndFileThreads({ status: "failed", severity: "urgent" });
    expect(threads.map((t) => t.source)).toEqual(["files", "bead"]);
    expect(threads[0]!.status).toBe("failed");
  });

  test("equal statuses keep bead threads before file clusters (derivation-order tiebreak)", () => {
    const threads = beadAndFileThreads(); // both agents completed
    expect(threads.map((t) => t.status)).toEqual(["completed", "completed"]);
    expect(threads.map((t) => t.source)).toEqual(["bead", "files"]);
  });

  test("no keys and no overlap yields no threads at all", () => {
    const s1 = sess({ sessionId: "a1", filesTouched: ["/r/a.ts"] });
    const s2 = sess({ sessionId: "a2", filesTouched: ["/r/b.ts"] });
    const p = prof("/r", [s1, s2]);
    expect(deriveTaskThreads([agent(p)], [p], new Map(), [])).toEqual([]);
  });
});
