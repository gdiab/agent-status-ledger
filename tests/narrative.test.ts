import { describe, expect, test } from "bun:test";
import type { AgentEvent, AgentProfile, CommitEvidence, FactSheet, RawSession } from "../src/types";
import { buildFactSheet, buildNarrativeFacts, generateNarrative, templateNarrative } from "../src/narrative";
import { REDACTION_MARKER } from "../src/redact";

const profile: AgentProfile = {
  profileId: "claude-code:/w", platform: "claude-code", workdir: "/w", displayName: "w (claude-code)",
  sessions: [
    {
      platform: "claude-code", sessionId: "s1", cwd: "/w", title: "Fix login bug",
      startedAt: "2026-07-07T09:00:00.000Z", lastEventAt: "2026-07-07T09:30:00.000Z",
      events: [{ timestamp: "2026-07-07T09:00:00.000Z", type: "run_started", summary: "s" }],
      filesTouched: ["/w/src/login.ts", "/w/src/login.ts"], errors: ["Error: flaky test"],
    },
    {
      platform: "claude-code", sessionId: "s2", cwd: "/w",
      startedAt: "2026-07-07T11:00:00.000Z", lastEventAt: "2026-07-07T11:30:00.000Z",
      events: [{ timestamp: "2026-07-07T11:00:00.000Z", type: "run_started", summary: "s" }],
      filesTouched: [], errors: [],
    },
  ],
};

const commits: CommitEvidence[] = [
  { sha: "a".repeat(40), authorDate: "2026-07-07T09:20:00.000Z", subject: "fix login redirect", attributed: true },
  { sha: "b".repeat(40), authorDate: "2026-07-07T15:00:00.000Z", subject: "human commit", attributed: false },
];

describe("buildFactSheet", () => {
  test("dedupes, includes only attributed commits, computes window", () => {
    const f = buildFactSheet(profile, commits);
    expect(f.titles).toEqual(["Fix login bug"]);
    expect(f.filesTouched).toEqual(["/w/src/login.ts"]);
    expect(f.commits).toEqual([`${"a".repeat(7)} fix login redirect`]);
    expect(f.sessionCount).toBe(2);
    expect(f.firstActivity).toBe("2026-07-07T09:00:00.000Z");
    expect(f.lastActivity).toBe("2026-07-07T11:30:00.000Z");
    expect(f.errors).toEqual(["Error: flaky test"]);
  });
});

// ── buildNarrativeFacts: bounded event-derived signal for the LLM prompt ────

function mkSession(sessionId: string, startedAt: string, events: AgentEvent[], over: Partial<RawSession> = {}): RawSession {
  return {
    platform: "codex", sessionId, cwd: "/w", startedAt,
    lastEventAt: events.at(-1)?.timestamp ?? startedAt,
    events, filesTouched: [], errors: [], ...over,
  };
}

function mkProfile(sessions: RawSession[]): AgentProfile {
  return { profileId: "codex:/w", platform: "codex", workdir: "/w", displayName: "w (codex)", sessions };
}

const at = (h: number, m = 0) =>
  `2026-07-07T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;

function enrichedFacts(profile: AgentProfile) {
  return buildNarrativeFacts(buildFactSheet(profile, []), profile, []);
}

describe("buildNarrativeFacts", () => {
  test("carries the last completion message per session, newest session first", () => {
    const profile = mkProfile([
      mkSession("s1", at(9), [
        { timestamp: at(9), type: "run_started", summary: "session started" },
        { timestamp: at(9, 30), type: "completed", summary: "Review verdict: LGTM with two nits" },
      ]),
      mkSession("s2", at(11), [
        { timestamp: at(11), type: "run_started", summary: "session started" },
        { timestamp: at(11, 15), type: "completed", summary: "intermediate answer" },
        { timestamp: at(11, 45), type: "completed", summary: "Final answer: the bug is in redact.ts" },
      ]),
    ]);
    const f = enrichedFacts(profile);
    expect(f.sessionOutcomes).toEqual([
      `${at(11, 45)} Final answer: the bug is in redact.ts`,
      `${at(9, 30)} Review verdict: LGTM with two nits`,
    ]);
  });

  test("caps outcomes to the newest sessions", () => {
    const sessions = Array.from({ length: 8 }, (_, i) =>
      mkSession(`s${i}`, at(i + 1), [{ timestamp: at(i + 1), type: "completed", summary: `conclusion ${i}` }]));
    const f = enrichedFacts(mkProfile(sessions));
    expect(f.sessionOutcomes).toHaveLength(5);
    expect(f.sessionOutcomes![0]).toContain("conclusion 7");
    expect(f.sessionOutcomes!.at(-1)).toContain("conclusion 3");
  });

  test("skips content-free summaries everywhere", () => {
    const profile = mkProfile([
      mkSession("s1", at(9), [
        { timestamp: at(9), type: "run_started", summary: "session started" },
        { timestamp: at(9, 1), type: "run_progressed", summary: "task_started" },
        { timestamp: at(9, 2), type: "run_progressed", summary: "agent_message" },
        { timestamp: at(9, 3), type: "run_progressed", summary: "user turn" },
        { timestamp: at(9, 4), type: "run_progressed", summary: "assistant turn" },
        { timestamp: at(9, 5), type: "completed", summary: "task complete" },
      ]),
    ]);
    const f = enrichedFacts(profile);
    expect(f.sessionOutcomes).toBeUndefined();
    expect(f.eventHighlights).toBeUndefined();
  });

  test("meaningful snake_case summary is kept as the session outcome", () => {
    // A verdict can be exactly one snake_case token; only the closed set of
    // connector type-name tokens is content-free. Dropping "request_changes"
    // would misreport the earlier intermediate completion as the conclusion.
    const profile = mkProfile([
      mkSession("s1", at(9), [
        { timestamp: at(9, 10), type: "completed", summary: "intermediate analysis of the diff" },
        { timestamp: at(9, 20), type: "run_progressed", summary: "task_started" },
        { timestamp: at(9, 30), type: "completed", summary: "request_changes" },
      ]),
    ]);
    const f = enrichedFacts(profile);
    expect(f.sessionOutcomes).toEqual([`${at(9, 30)} request_changes`]);
  });

  test("highlights dedupe on the sanitized line, not raw summaries", () => {
    const mkSecret = (c: string) => `sk-${c.repeat(24)}`;
    const events: AgentEvent[] = ["a", "b"].map((c, i) => ({
      timestamp: at(9, i), type: "failed" as const, summary: `auth failed with ${mkSecret(c)}`,
    }));
    const f = enrichedFacts(mkProfile([mkSession("s1", at(9), events)]));
    expect(f.eventHighlights).toHaveLength(1);
    expect(f.eventHighlights![0]).toContain(REDACTION_MARKER);
  });

  test("prioritizes failures over other events when over the line cap", () => {
    const noise: AgentEvent[] = Array.from({ length: 20 }, (_, i) => ({
      timestamp: at(10, i), type: "run_progressed" as const, summary: `progress detail ${i}`,
    }));
    const failures: AgentEvent[] = Array.from({ length: 4 }, (_, i) => ({
      timestamp: at(12, i), type: "failed" as const, summary: `boom ${i}`,
    }));
    const f = enrichedFacts(mkProfile([mkSession("s1", at(10), [...noise, ...failures])]));
    expect(f.eventHighlights).toHaveLength(12);
    for (let i = 0; i < 4; i++) expect(f.eventHighlights!.join("\n")).toContain(`boom ${i}`);
    // failures come first, then recent progress
    expect(f.eventHighlights![0]).toContain("boom 3");
  });

  test("enforces per-line caps including ellipsis and total line cap", () => {
    const long = "x".repeat(1000);
    const events: AgentEvent[] = [
      { timestamp: at(9), type: "failed", summary: long },
      { timestamp: at(9, 30), type: "completed", summary: long },
      ...Array.from({ length: 40 }, (_, i) => ({
        timestamp: at(10, i % 60), type: "run_progressed" as const, summary: `detail ${i} ${long}`,
      })),
    ];
    const f = enrichedFacts(mkProfile([mkSession("s1", at(9), events)]));
    expect(f.eventHighlights!.length).toBeLessThanOrEqual(12);
    for (const line of f.eventHighlights!) {
      expect(line.length).toBeLessThanOrEqual(200);
      expect(line.endsWith("…")).toBe(true);
    }
    for (const line of f.sessionOutcomes!) {
      expect(line.length).toBeLessThanOrEqual(400);
    }
  });

  test("outcome lines flow through redaction before capping", () => {
    const secret = `sk-${"a".repeat(24)}`;
    const profile = mkProfile([
      mkSession("s1", at(9), [
        { timestamp: at(9), type: "completed", summary: `done, key was ${secret}` },
        { timestamp: at(9, 5), type: "failed", summary: `auth failed with ${secret}` },
      ]),
    ]);
    const f = buildNarrativeFacts(buildFactSheet(profile, []), profile, []);
    const all = [...(f.sessionOutcomes ?? []), ...(f.eventHighlights ?? [])].join("\n");
    expect(all).not.toContain(secret);
    expect(all).toContain(REDACTION_MARKER);
  });

  test("completion events used as outcomes are not duplicated into highlights", () => {
    const profile = mkProfile([
      mkSession("s1", at(9), [
        { timestamp: at(9, 30), type: "completed", summary: "the only conclusion" },
      ]),
    ]);
    const f = enrichedFacts(profile);
    expect(f.sessionOutcomes).toHaveLength(1);
    expect(f.eventHighlights).toBeUndefined();
  });

  test("base factsheet fields pass through untouched", () => {
    const f = buildNarrativeFacts(buildFactSheet(profile, commits), profile, []);
    expect(f.titles).toEqual(["Fix login bug"]);
    expect(f.sessionCount).toBe(2);
  });

  test("codex-review-shaped profile (no titles/files/commits) still yields usable content", () => {
    const verdict = "Overall: the diff is correct. Two findings: (1) missing null check in parse(); (2) test asserts wrong constant.";
    const profile = mkProfile([
      mkSession("rev1", at(8), [
        { timestamp: at(8), type: "run_started", summary: "session started" },
        { timestamp: at(8, 1), type: "run_progressed", summary: "task_started" },
        { timestamp: at(8, 40), type: "completed", summary: verdict },
      ]),
    ]);
    const f = enrichedFacts(profile);
    expect(f.titles).toEqual([]);
    expect(f.commits).toEqual([]);
    expect(f.sessionOutcomes).toEqual([`${at(8, 40)} ${verdict}`]);
  });
});

describe("templateNarrative", () => {
  test("produces all six fields from facts alone", () => {
    const n = templateNarrative(buildFactSheet(profile, commits), "completed");
    expect(n.workedOn).toContain("Fix login bug");
    expect(n.completed).toContain("fix login redirect");
    for (const v of Object.values(n)) expect(typeof v).toBe("string");
  });

  test("standup is first person and grounded in the facts", () => {
    const n = templateNarrative(buildFactSheet(profile, commits), "completed");
    expect(n.standup).toMatch(/^I /);
    expect(n.standup).toContain("Fix login bug");
    expect(n.standup).toContain("1 commit");
  });

  test("standup mentions waiting on human when status needs_human", () => {
    const n = templateNarrative(buildFactSheet(profile, commits), "needs_human");
    expect(n.standup).toContain("waiting on you");
  });
});

describe("generateNarrative", () => {
  const facts: FactSheet = buildFactSheet(profile, commits);

  test("uses LLM response when valid", async () => {
    const canned = { workedOn: "w", completed: "c", inProgress: "i", blocked: "b", recommendation: "r", standup: "I fixed the login redirect and committed it." };
    const fetchFn = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      expect(body.model).toBe("claude-haiku-4-5-20251001");
      expect(JSON.stringify(body)).not.toContain("transcript");
      return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(canned) }] }), { status: 200 });
    }) as typeof fetch;
    const r = await generateNarrative(facts, "completed", { model: "claude-haiku-4-5-20251001", apiKey: "k", fetchFn });
    expect(r.source).toBe("llm");
    expect(r.narrative).toEqual(canned);
  });

  test("falls back to template without apiKey", async () => {
    const r = await generateNarrative(facts, "completed", { model: "m" });
    expect(r.source).toBe("template");
  });

  test("falls back on API error", async () => {
    const fetchFn = (async () => new Response("overloaded", { status: 529 })) as unknown as typeof fetch;
    const r = await generateNarrative(facts, "completed", { model: "m", apiKey: "k", fetchFn });
    expect(r.source).toBe("template");
  });

  test("falls back on malformed LLM output", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ content: [{ type: "text", text: "not json at all" }] }), { status: 200 })) as unknown as typeof fetch;
    const r = await generateNarrative(facts, "completed", { model: "m", apiKey: "k", fetchFn });
    expect(r.source).toBe("template");
  });

  test("prompt carries sessionOutcomes and eventHighlights when present", async () => {
    const enriched = {
      ...facts,
      sessionOutcomes: ["2026-07-07T09:30:00.000Z Review verdict: LGTM"],
      eventHighlights: ["2026-07-07T09:10:00.000Z failed: boom"],
    };
    let prompt = "";
    const fetchFn = (async (_url: any, init: any) => {
      prompt = JSON.parse(init.body).messages[0].content;
      return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ workedOn: "w", completed: "c", inProgress: "i", blocked: "b", recommendation: "r", standup: "I did." }) }] }), { status: 200 });
    }) as typeof fetch;
    await generateNarrative(enriched, "completed", { model: "m", apiKey: "k", fetchFn });
    expect(prompt).toContain("Review verdict: LGTM");
    expect(prompt).toContain("failed: boom");
  });

  test("templateNarrative ignores enrichment fields (no-llm output unchanged)", () => {
    const enriched = { ...facts, sessionOutcomes: ["x"], eventHighlights: ["y"] };
    expect(templateNarrative(enriched, "completed")).toEqual(templateNarrative(facts, "completed"));
  });

  test("LLM response missing standup keeps llm source, template-fills standup only", async () => {
    const canned = { workedOn: "w", completed: "c", inProgress: "i", blocked: "b", recommendation: "r" };
    const fetchFn = (async () =>
      new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(canned) }] }), { status: 200 })) as unknown as typeof fetch;
    const r = await generateNarrative(facts, "completed", { model: "m", apiKey: "k", fetchFn });
    expect(r.source).toBe("llm");
    expect(r.narrative.workedOn).toBe("w");
    expect(r.narrative.standup).toMatch(/^I /);
  });
});
