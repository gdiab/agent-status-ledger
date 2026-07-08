import { describe, expect, test } from "bun:test";
import type { AgentProfile, CommitEvidence, FactSheet } from "../src/types";
import { buildFactSheet, generateNarrative, templateNarrative } from "../src/narrative";

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

describe("templateNarrative", () => {
  test("produces all five fields from facts alone", () => {
    const n = templateNarrative(buildFactSheet(profile, commits), "completed");
    expect(n.workedOn).toContain("Fix login bug");
    expect(n.completed).toContain("fix login redirect");
    for (const v of Object.values(n)) expect(typeof v).toBe("string");
  });
});

describe("generateNarrative", () => {
  const facts: FactSheet = buildFactSheet(profile, commits);

  test("uses LLM response when valid", async () => {
    const canned = { workedOn: "w", completed: "c", inProgress: "i", blocked: "b", recommendation: "r" };
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
    const fetchFn = (async () => new Response("overloaded", { status: 529 })) as typeof fetch;
    const r = await generateNarrative(facts, "completed", { model: "m", apiKey: "k", fetchFn });
    expect(r.source).toBe("template");
  });

  test("falls back on malformed LLM output", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ content: [{ type: "text", text: "not json at all" }] }), { status: 200 })) as typeof fetch;
    const r = await generateNarrative(facts, "completed", { model: "m", apiKey: "k", fetchFn });
    expect(r.source).toBe("template");
  });
});
