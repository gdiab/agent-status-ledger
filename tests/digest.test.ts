import { describe, expect, test } from "bun:test";
import type { AgentReport, Report, TaskThread, ThreadSession } from "../src/types";
import type { SanitizedTapeText } from "../src/redact";
import { AWAITING_QUESTION_MAX, leadSentence, renderEmailDigest } from "../src/render/digest";

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

  test("exception row carries the awaiting question on one line; absent field, absent line", () => {
    const waiting: AgentReport = {
      ...blocked,
      awaitingQuestion: "retry with backoff, or fail the deploy?" as SanitizedTapeText,
    };
    const html = renderEmailDigest({ ...report, agents: [agent({}), waiting], exceptions: [waiting] });
    const box = html.slice(html.indexOf("Exceptions"), html.indexOf("</div>"));
    expect(box).toContain("Waiting on: “retry with backoff, or fail the deploy?”");
    // absent question keeps the plain row (also pinned by NO_THREADS_GOLDEN)
    const bare = renderEmailDigest(report);
    expect(bare).not.toContain("Waiting on");
  });

  test("awaiting question is truncated at AWAITING_QUESTION_MAX with an ellipsis; the boundary survives intact", () => {
    const atCap = "q".repeat(AWAITING_QUESTION_MAX);
    const overCap = "q".repeat(AWAITING_QUESTION_MAX + 1);
    const htmlAt = renderEmailDigest({
      ...report,
      exceptions: [{ ...blocked, awaitingQuestion: atCap as SanitizedTapeText }],
    });
    expect(htmlAt).toContain(`“${atCap}”`);
    expect(htmlAt).not.toContain("…");
    const htmlOver = renderEmailDigest({
      ...report,
      exceptions: [{ ...blocked, awaitingQuestion: overCap as SanitizedTapeText }],
    });
    expect(htmlOver).toContain(`“${"q".repeat(AWAITING_QUESTION_MAX - 1)}…”`);
    expect(htmlOver).not.toContain(atCap); // never more than the cap
  });

  test("hostile content in the awaiting question is escaped, and truncation happens before escaping", () => {
    const hostile = `<img src=x onerror=alert(1)>${"a".repeat(AWAITING_QUESTION_MAX)}`;
    const html = renderEmailDigest({
      ...report,
      exceptions: [{ ...blocked, awaitingQuestion: hostile as SanitizedTapeText }],
    });
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    // truncated on raw chars, then escaped — the entity is not sliced mid-way
    expect(html).toContain("…");
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

  // Golden copy of the no-threads digest, captured before the thread rollup
  // landed. Pins the legacy shape byte-for-byte: absent threads must keep
  // producing exactly this document (no Task threads section, no Agents
  // heading), so any drift in the legacy path fails loudly instead of
  // sliding past an absent-vs-undefined comparison that exercises the same
  // code on both sides.
  const NO_THREADS_GOLDEN = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Agent Standup — 2026-07-08</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width:40rem; margin:0 auto; padding:1rem; color:#1a1a1a; line-height:1.4;">
<h1 style="font-size:1.2rem; margin:0 0 .3rem;">Agent Standup — 2026-07-08</h1>
<p style="margin:0 0 1rem; font-size:.9rem; opacity:.75;">2 agents: 1 needs_human, 1 completed — 1 commit, 1 file touched</p>
<div style="border:1px solid #c0392b55; border-radius:8px; padding:.75rem 1rem; margin:0 0 1rem;">
  <h2 style="font-size:1rem; margin:0 0 .5rem;">Exceptions</h2>
  <ul style="margin:0; padding-left:1.1rem;"><li style="margin:0 0 .4rem;"><strong>infra (codex)</strong> — needs_human: Needs a human call on retry semantics.</li></ul>
</div>
<table role="presentation" style="width:100%; border-collapse:collapse; margin:0 0 1rem;"><tr>
  <td style="padding:.6rem 0; border-top:3px solid #2d7a46; border-bottom:1px solid #8884;">
    <div style="font-weight:600;">w (claude-code) <span style="font-weight:400; opacity:.7;">— completed</span></div>
    <div style="font-size:.85rem; opacity:.7; margin:.15rem 0;">1 commit, 1 file touched</div>
    <div style="font-size:.9rem; margin-top:.2rem;">I fixed the login bug and committed the fix.</div>
  </td>
</tr><tr>
  <td style="padding:.6rem 0; border-top:3px solid #8a6d00; border-bottom:1px solid #8884;">
    <div style="font-weight:600;">infra (codex) <span style="font-weight:400; opacity:.7;">— needs_human</span></div>
    <div style="font-size:.85rem; opacity:.7; margin:.15rem 0;">0 commits, 0 files touched</div>
    <div style="font-size:.9rem; margin-top:.2rem;">I'm blocked on the retry policy decision.</div>
  </td>
</tr></table>
<p style="font-size:.8rem; opacity:.6; margin-top:1rem;">Full interactive report attached.</p>
</body>
</html>
`;

  test("no threads: legacy digest output matches the pre-threads golden byte-for-byte", () => {
    expect(renderEmailDigest(report)).toBe(NO_THREADS_GOLDEN);
    expect(renderEmailDigest({ ...report, threads: undefined })).toBe(NO_THREADS_GOLDEN);
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

  test("threads render in report order — deriveTaskThreads' worst-status-first is canonical", () => {
    // deriveTaskThreads sorts worst-status-first (bead-before-cluster within
    // a status); the digest must not re-order, so the canonical order is the
    // one every surface (markdown, HTML, JSON, digest) shows. The fixture is
    // deliberately NOT in status order — a reintroduced status re-sort in the
    // digest would move asl-ok and fail this test.
    const html = renderEmailDigest({
      ...report,
      threads: [
        thread({ threadKey: "asl-ok", title: "asl-ok", source: "bead", status: "completed" }),
        thread({ threadKey: "files:/w/src/login.ts", title: "login.ts, session.ts", source: "files", status: "failed" }),
        thread({ threadKey: "asl-stuck", title: "asl-stuck", source: "bead", status: "blocked" }),
        thread({ threadKey: "files:/w/src/api.ts", title: "api.ts", source: "files", status: "blocked" }),
      ],
    });
    const order = ["asl-ok", "login.ts, session.ts", "asl-stuck", "api.ts"].map((t) => html.indexOf(t));
    expect(order.every((i) => i > -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b)); // report order preserved verbatim
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
