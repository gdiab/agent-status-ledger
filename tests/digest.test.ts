import { describe, expect, test } from "bun:test";
import type { AgentReport, Report, TaskThread, ThreadSession } from "../src/types";
import { leadSentence, renderEmailDigest } from "../src/render/digest";

describe("leadSentence", () => {
  test("returns the first sentence of a multi-sentence standup", () => {
    expect(leadSentence("I fixed the login bug and committed the fix. Nothing is blocking me.")).toBe(
      "I fixed the login bug and committed the fix.",
    );
  });

  test("stops at ! or ? as well as .", () => {
    expect(leadSentence("I shipped it! Onward.")).toBe("I shipped it!");
    expect(leadSentence("Am I blocked? Not anymore.")).toBe("Am I blocked?");
  });

  test("returns the whole string unchanged when there is no terminal punctuation", () => {
    expect(leadSentence("I am mid-task with no period")).toBe("I am mid-task with no period");
  });

  test("a single-sentence standup returns itself", () => {
    expect(leadSentence("I am done.")).toBe("I am done.");
  });
});

function agent(over: Partial<AgentReport>): AgentReport {
  return {
    profileId: "claude-code:/w", displayName: "w (claude-code)", platform: "claude-code", workdir: "/w",
    status: "completed", severity: "info", evidence: "proven",
    facts: {
      titles: ["Fix login bug"], filesTouched: ["/w/src/login.ts"], errors: [],
      commits: ["abc1234 fix login redirect"], sessionCount: 1,
      firstActivity: "2026-07-07T09:00:00.000Z", lastActivity: "2026-07-07T09:30:00.000Z",
    },
    narrative: {
      workedOn: "Fixed login.", completed: "Login fix committed.", inProgress: "Nothing.", blocked: "None.",
      recommendation: "Review the commit.",
      standup: "I fixed the login bug and committed the fix. Nothing is blocking me.",
    },
    narrativeSource: "template",
    commits: [{ sha: "abc1234abcdefghijklmnopqrstuvwxyz123456", authorDate: "2026-07-07T09:20:00.000Z", subject: "fix login redirect", attributed: true }],
    ...over,
  };
}

const blocked = agent({
  profileId: "codex:/infra", displayName: "infra (codex)", status: "needs_human", severity: "warning",
  evidence: "claimed_only",
  facts: {
    titles: ["Investigate deploy failure"], filesTouched: [], errors: [],
    commits: [], sessionCount: 1,
    firstActivity: "2026-07-08T06:00:00.000Z", lastActivity: "2026-07-08T06:45:00.000Z",
  },
  commits: [],
  narrative: {
    workedOn: "Investigated the deploy failure.", completed: "Nothing.", inProgress: "Root-causing the timeout.",
    blocked: "Waiting on a decision about the retry policy.", recommendation: "Needs a human call on retry semantics.",
    standup: "I'm blocked on the retry policy decision. Someone needs to weigh in.",
  },
});

const report: Report = {
  schemaVersion: 1,
  generatedAt: "2026-07-08T07:00:00.000Z",
  windowStart: "2026-07-07T07:00:00.000Z",
  windowEnd: "2026-07-08T07:00:00.000Z",
  exceptions: [blocked],
  agents: [agent({}), blocked],
};

describe("renderEmailDigest", () => {
  test("includes the shared rollupLine rollup sentence", () => {
    const html = renderEmailDigest(report);
    expect(html).toContain("2 agents: 1 needs_human, 1 completed — 1 commit, 1 file touched");
  });

  test("one row per agent with name, status, counts, and lead sentence", () => {
    const html = renderEmailDigest(report);
    expect(html).toContain("w (claude-code)");
    expect(html).toContain("— completed");
    expect(html).toContain("1 commit, 1 file touched");
    expect(html).toContain("I fixed the login bug and committed the fix.");
    expect(html).toContain("infra (codex)");
    expect(html).toContain("— needs_human");
    // esc() does not escape apostrophes (see src/render/html.ts's esc()), so
    // this appears verbatim.
    expect(html).toContain("I'm blocked on the retry policy decision.");
  });

  test("exceptions section lists one-line context for exception agents only", () => {
    const html = renderEmailDigest(report);
    expect(html).toContain("Needs a human call on retry semantics.");
    expect(html).not.toContain("Review the commit."); // non-exception agent's recommendation stays out of Exceptions
  });

  test("no exceptions renders the reassurance line", () => {
    const html = renderEmailDigest({ ...report, exceptions: [] });
    expect(html).toContain("No exceptions — nothing needs you.");
  });

  test("no agent activity renders a message instead of an empty table", () => {
    const html = renderEmailDigest({ ...report, agents: [], exceptions: [] });
    expect(html).not.toContain("<table");
    expect(html).toContain("No agent activity in this window.");
  });

  test("never emits <details>, CSS grid, or light-dark() — the exact patterns Gmail flattens", () => {
    const html = renderEmailDigest(report);
    expect(html).not.toContain("<details");
    expect(html).not.toContain("<summary");
    expect(html).not.toContain("display: grid");
    expect(html).not.toContain("display:grid");
    expect(html).not.toContain("light-dark(");
    expect(html).not.toContain("<style");
  });

  test("escapes HTML in agent-controlled fields", () => {
    const hostile = agent({ displayName: "<img src=x onerror=alert(1)>" });
    const html = renderEmailDigest({ ...report, agents: [hostile], exceptions: [] });
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});

function threadSession(over: Partial<ThreadSession>): ThreadSession {
  return {
    sessionId: "aaaaaaaa-1111-2222-3333-444444444444", profile: "w (claude-code)",
    startedAt: "2026-07-07T09:00:00.000Z", lastEventAt: "2026-07-07T09:30:00.000Z",
    files: 3, commits: 2, errors: 0,
    ...over,
  };
}

function thread(over: Partial<TaskThread>): TaskThread {
  return {
    threadKey: "asl-abc", source: "bead", title: "asl-abc",
    status: "blocked", evidence: "proven",
    firstActivityAt: "2026-07-07T09:00:00.000Z", lastActivityAt: "2026-07-08T06:45:00.000Z",
    sessions: [
      threadSession({}),
      threadSession({
        sessionId: "bbbbbbbb-1111-2222-3333-444444444444", profile: "infra (codex)",
        startedAt: "2026-07-08T06:00:00.000Z", lastEventAt: "2026-07-08T06:45:00.000Z",
        files: 0, commits: 1, errors: 0,
      }),
    ],
    ...over,
  };
}

describe("renderEmailDigest with task threads (PRD §7)", () => {
  const threaded: Report = { ...report, threads: [thread({})] };

  test("no threads: no Task threads section, output unchanged", () => {
    expect(renderEmailDigest(report)).not.toContain("Task threads");
    expect(renderEmailDigest(report)).toBe(renderEmailDigest({ ...report, threads: undefined }));
  });

  test("empty threads array behaves like no threads", () => {
    expect(renderEmailDigest({ ...report, threads: [] })).toBe(renderEmailDigest(report));
  });

  test("threads render a Task threads section with key, status, and rollup phrase", () => {
    const html = renderEmailDigest(threaded);
    expect(html).toContain("Task threads");
    expect(html).toContain("asl-abc");
    expect(html).toContain("— blocked");
    expect(html).toContain("2 sessions, 3 commits"); // per-member commits summed (exclusive by construction)
  });

  test("thread section sits between the exceptions triage and the per-agent rows", () => {
    const html = renderEmailDigest(threaded);
    const exceptions = html.indexOf("Exceptions");
    const threads = html.indexOf("Task threads");
    const firstAgent = html.indexOf("w (claude-code)");
    expect(exceptions).toBeGreaterThan(-1);
    expect(threads).toBeGreaterThan(exceptions);
    expect(firstAgent).toBeGreaterThan(threads);
  });

  test("file-cluster threads are labelled as such", () => {
    const html = renderEmailDigest({
      ...report,
      threads: [thread({ threadKey: "files:/w/src/login.ts", source: "files", title: "login.ts, session.ts" })],
    });
    expect(html).toContain("login.ts, session.ts");
    expect(html).toContain("(file cluster)");
  });

  test("bead threads carry no file-cluster label", () => {
    expect(renderEmailDigest(threaded)).not.toContain("(file cluster)");
  });

  test("thread errors surface in the rollup phrase; zero errors are suppressed", () => {
    const noisy = thread({
      sessions: [threadSession({}), threadSession({ sessionId: "cccccccc-1111-2222-3333-444444444444", errors: 2 })],
    });
    expect(renderEmailDigest({ ...report, threads: [noisy] })).toContain("2 sessions, 4 commits, 2 errors");
    expect(renderEmailDigest(threaded)).not.toContain("error");
  });

  test("all agents exceptions + threads: exceptions triage still leads, threads follow", () => {
    const allExceptions: Report = {
      ...report,
      agents: [blocked, agent({ profileId: "claude-code:/x", displayName: "x (claude-code)", status: "failed", severity: "urgent" })],
      exceptions: [blocked, agent({ profileId: "claude-code:/x", displayName: "x (claude-code)", status: "failed", severity: "urgent" })],
      threads: [thread({ status: "failed" })],
    };
    const html = renderEmailDigest(allExceptions);
    // Exception surfacing keeps its posture: the triage box is first and
    // still names every exception agent's recommendation.
    expect(html.indexOf("Exceptions")).toBeLessThan(html.indexOf("Task threads"));
    expect(html).toContain("Needs a human call on retry semantics.");
    // The thread rollup still renders, worst status and all.
    expect(html).toContain("asl-abc");
    expect(html).toContain("— failed");
  });

  test("escapes HTML in thread-controlled fields", () => {
    const hostile = thread({ title: "<script>alert(1)</script>" });
    const html = renderEmailDigest({ ...report, threads: [hostile] });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  test("thread section never emits the patterns Gmail flattens", () => {
    const html = renderEmailDigest(threaded);
    expect(html).not.toContain("<details");
    expect(html).not.toContain("<summary");
    expect(html).not.toContain("display: grid");
    expect(html).not.toContain("display:grid");
    expect(html).not.toContain("light-dark(");
    expect(html).not.toContain("<style");
  });
});
