import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentReport, CommitEvidence, Report } from "../src/types";
import { annotateTrends, loadPreviousReport } from "../src/trends";
import { EXCEPTION_STATUSES } from "../src/status";

function commit(i: number, attributed = true): CommitEvidence {
  return { sha: `${i}bc1234abcdefghijklmnopqrstuvwxyz123456`, authorDate: "2026-07-07T09:20:00.000Z", subject: `commit ${i}`, attributed };
}

function agent(over: Partial<AgentReport>): AgentReport {
  return {
    profileId: "claude-code:/w", displayName: "w (claude-code)", platform: "claude-code", workdir: "/w",
    status: "completed", severity: "info", evidence: "proven",
    facts: {
      titles: ["Fix login bug"], filesTouched: ["/w/src/login.ts"], errors: [],
      commits: ["abc1234 fix login redirect"], sessionCount: 1,
      firstActivity: "2026-07-08T09:00:00.000Z", lastActivity: "2026-07-08T09:30:00.000Z",
    },
    narrative: { workedOn: "Fixed login.", completed: "Login fix committed.", inProgress: "Nothing.", blocked: "None.", recommendation: "Review the commit.", standup: "I fixed the login bug." },
    narrativeSource: "template",
    commits: [commit(0)],
    ...over,
  };
}

function makeReport(agents: AgentReport[], over: Partial<Report> = {}): Report {
  return {
    schemaVersion: 1,
    generatedAt: "2026-07-08T07:00:00.000Z",
    windowStart: "2026-07-07T07:00:00.000Z",
    windowEnd: "2026-07-08T07:00:00.000Z",
    exceptions: agents.filter((a) => EXCEPTION_STATUSES.has(a.status)),
    agents,
    ...over,
  };
}

// Previous report, one day earlier by default.
function prevReport(agents: AgentReport[], over: Partial<Report> = {}): Report {
  return makeReport(agents, {
    generatedAt: "2026-07-07T07:00:00.000Z",
    windowStart: "2026-07-06T07:00:00.000Z",
    windowEnd: "2026-07-07T07:00:00.000Z",
    ...over,
  });
}

describe("annotateTrends", () => {
  test("no previous report: returns the report unchanged", () => {
    const report = makeReport([agent({})]);
    const out = annotateTrends(report, undefined);
    expect(out).toBe(report);
    expect(out.trends).toBeUndefined();
    expect(out.agents[0]!.trends).toBeUndefined();
  });

  test("status streak: same noteworthy status yesterday annotates honestly", () => {
    const today = makeReport([agent({ status: "silent", severity: "urgent" })]);
    const prev = prevReport([agent({ status: "silent", severity: "urgent" })]);
    const out = annotateTrends(today, prev);
    expect(out.agents[0]!.trends).toContain("also silent yesterday");
  });

  test("status streak: every noteworthy status qualifies", () => {
    for (const status of ["silent", "blocked", "failed", "needs_human"] as const) {
      const out = annotateTrends(
        makeReport([agent({ status })]),
        prevReport([agent({ status })]),
      );
      expect(out.agents[0]!.trends).toContain(`also ${status} yesterday`);
    }
  });

  test("status streak: non-noteworthy repeat statuses do not annotate", () => {
    const out = annotateTrends(makeReport([agent({})]), prevReport([agent({})]));
    expect(out.agents[0]!.trends).toBeUndefined();
  });

  test("status streak: noteworthy today but different status yesterday does not annotate", () => {
    const out = annotateTrends(
      makeReport([agent({ status: "silent" })]),
      prevReport([agent({ status: "active" })]),
    );
    expect(out.agents[0]!.trends).toBeUndefined();
  });

  test("non-consecutive previous report is dated, never called yesterday", () => {
    const prev = prevReport([agent({ status: "silent" })], {
      windowStart: "2026-07-04T07:00:00.000Z",
      windowEnd: "2026-07-05T07:00:00.000Z",
    });
    const out = annotateTrends(makeReport([agent({ status: "silent" })]), prev);
    expect(out.agents[0]!.trends).toContain("also silent on 2026-07-05");
    expect(JSON.stringify(out.agents[0]!.trends)).not.toContain("yesterday");
  });

  test("commit velocity: attributed count delta per agent, signed", () => {
    const up = annotateTrends(
      makeReport([agent({ commits: [commit(0), commit(1), commit(2)] })]),
      prevReport([agent({ commits: [commit(0)] })]),
    );
    expect(up.agents[0]!.trends).toContain("3 commits vs 1 yesterday (+2)");
    const down = annotateTrends(
      makeReport([agent({ commits: [commit(0)] })]),
      prevReport([agent({ commits: [commit(0), commit(1)] })]),
    );
    expect(down.agents[0]!.trends).toContain("1 commit vs 2 yesterday (-1)");
  });

  test("commit velocity: unattributed commits do not count", () => {
    const out = annotateTrends(
      makeReport([agent({ commits: [commit(0), commit(1, false)] })]),
      prevReport([agent({ commits: [commit(0)] })]),
    );
    expect(out.agents[0]!.trends).toBeUndefined();
  });

  test("commit velocity: equal counts stay quiet", () => {
    const out = annotateTrends(
      makeReport([agent({})]),
      prevReport([agent({})]),
    );
    expect(out.agents[0]!.trends).toBeUndefined();
    expect(out.trends).toBeUndefined();
  });

  test("agent absent from the previous report gets no annotations", () => {
    const out = annotateTrends(
      makeReport([agent({ status: "silent", commits: [commit(0), commit(1)] })]),
      prevReport([agent({ profileId: "codex:/other", status: "silent" })]),
    );
    expect(out.agents[0]!.trends).toBeUndefined();
  });

  test("recurring errors: identical error line both days is marked", () => {
    const facts = agent({}).facts;
    const out = annotateTrends(
      makeReport([agent({ facts: { ...facts, errors: ["boom — while Bash: x", "fresh error"] } })]),
      prevReport([agent({ facts: { ...facts, errors: ["boom — while Bash: x", "old error"] } })]),
    );
    expect(out.agents[0]!.trends).toContain("1 recurring error (also seen yesterday)");
  });

  test("recurring errors: plural count", () => {
    const facts = agent({}).facts;
    const errors = ["err one", "err two"];
    const out = annotateTrends(
      makeReport([agent({ facts: { ...facts, errors } })]),
      prevReport([agent({ facts: { ...facts, errors } })]),
    );
    expect(out.agents[0]!.trends).toContain("2 recurring errors (also seen yesterday)");
  });

  test("recurring errors: disjoint error lines stay quiet", () => {
    const facts = agent({}).facts;
    const out = annotateTrends(
      makeReport([agent({ facts: { ...facts, errors: ["new failure"] } })]),
      prevReport([agent({ facts: { ...facts, errors: ["old failure"] } })]),
    );
    expect(out.agents[0]!.trends).toBeUndefined();
  });

  test("report-level total commit velocity across all agents", () => {
    const b = (over: Partial<AgentReport>) => agent({ profileId: "codex:/b", displayName: "b (codex)", ...over });
    const out = annotateTrends(
      makeReport([agent({ commits: [commit(0)] }), b({ commits: [commit(1)] })]),
      prevReport([agent({ commits: [commit(0), commit(1), commit(2)] }), b({ commits: [commit(3), commit(4)] })]),
    );
    expect(out.trends).toContain("2 commits vs 5 yesterday (-3)");
  });

  test("exceptions carry the same annotated agent objects", () => {
    const out = annotateTrends(
      makeReport([agent({ status: "silent", severity: "urgent" })]),
      prevReport([agent({ status: "silent", severity: "urgent" })]),
    );
    expect(out.exceptions[0]).toBe(out.agents[0]!);
    expect(out.exceptions[0]!.trends).toContain("also silent yesterday");
  });
});

describe("loadPreviousReport", () => {
  const DAY = "2026-07-08";

  function dir(): string {
    return mkdtempSync(join(tmpdir(), "asl-trends-"));
  }

  function writeReport(d: string, day: string, over: Partial<Report> = {}) {
    const report = prevReport([agent({})], { windowEnd: `${day}T07:00:00.000Z`, ...over });
    writeFileSync(join(d, `${day}.json`), JSON.stringify(report, null, 2));
  }

  test("missing directory yields undefined", async () => {
    expect(await loadPreviousReport(join(dir(), "nope"), DAY)).toBeUndefined();
  });

  test("empty directory yields undefined", async () => {
    expect(await loadPreviousReport(dir(), DAY)).toBeUndefined();
  });

  test("only same-day and newer reports yield undefined", async () => {
    const d = dir();
    writeReport(d, "2026-07-08");
    writeReport(d, "2026-07-09");
    expect(await loadPreviousReport(d, DAY)).toBeUndefined();
  });

  test("picks the most recent report strictly older than the current day", async () => {
    const d = dir();
    writeReport(d, "2026-07-05");
    writeReport(d, "2026-07-07");
    writeReport(d, "2026-07-08");
    const prev = await loadPreviousReport(d, DAY);
    expect(prev?.windowEnd).toBe("2026-07-07T07:00:00.000Z");
  });

  test("non-report files are ignored", async () => {
    const d = dir();
    writeFileSync(join(d, "2026-07-07.md"), "# not json");
    writeFileSync(join(d, "notes.json"), "{}");
    mkdirSync(join(d, "2026-07-06.json.d"));
    expect(await loadPreviousReport(d, DAY)).toBeUndefined();
  });

  test("unparseable JSON yields undefined, no crash", async () => {
    const d = dir();
    writeFileSync(join(d, "2026-07-07.json"), "{ not json");
    expect(await loadPreviousReport(d, DAY)).toBeUndefined();
  });

  test("unknown schemaVersion yields undefined", async () => {
    const d = dir();
    const report = { ...prevReport([agent({})]), schemaVersion: 99 };
    writeFileSync(join(d, "2026-07-07.json"), JSON.stringify(report));
    expect(await loadPreviousReport(d, DAY)).toBeUndefined();
  });

  test("malformed report shape (no agents array) yields undefined", async () => {
    const d = dir();
    writeFileSync(join(d, "2026-07-07.json"), JSON.stringify({ schemaVersion: 1 }));
    expect(await loadPreviousReport(d, DAY)).toBeUndefined();
  });

  test("malformed agent entries (missing commits/facts) yield undefined — trends must never crash the report", async () => {
    const d = dir();
    writeFileSync(join(d, "2026-07-07.json"), JSON.stringify({
      schemaVersion: 1,
      windowEnd: "2026-07-07T07:00:00.000Z",
      agents: [{ profileId: "claude-code:/w", status: "silent" }],
    }));
    expect(await loadPreviousReport(d, DAY)).toBeUndefined();
  });

  test("a null entry in an agent's commits yields undefined", async () => {
    const d = dir();
    const report = prevReport([agent({})]);
    (report.agents[0]!.commits as unknown[]).push(null);
    writeFileSync(join(d, "2026-07-07.json"), JSON.stringify(report));
    expect(await loadPreviousReport(d, DAY)).toBeUndefined();
  });

  test("a windowEnd that is not ISO-date-shaped yields undefined (its date slice reaches markdown)", async () => {
    const d = dir();
    writeReport(d, "2026-07-07", { windowEnd: "<script>x" });
    expect(await loadPreviousReport(d, DAY)).toBeUndefined();
  });

  test("valid prior report round-trips into annotateTrends", async () => {
    const d = dir();
    writeReport(d, "2026-07-07", { agents: [agent({ status: "silent" })] });
    const prev = await loadPreviousReport(d, DAY);
    expect(prev).toBeDefined();
    const out = annotateTrends(makeReport([agent({ status: "silent" })]), prev);
    expect(out.agents[0]!.trends).toContain("also silent yesterday");
  });
});
