import { describe, expect, test } from "bun:test";
import type { AgentReport, Report } from "../src/types";
import { renderMarkdown } from "../src/render/markdown";
import { renderJson } from "../src/render/json";
import { renderHtml } from "../src/render/html";
import { STATUS_HELP, EVIDENCE_HELP } from "../src/render/legend";

function agent(over: Partial<AgentReport>): AgentReport {
  return {
    profileId: "claude-code:/w", displayName: "w (claude-code)", platform: "claude-code", workdir: "/w",
    status: "completed", severity: "info", evidence: "proven",
    facts: {
      titles: ["Fix login bug"], filesTouched: ["/w/src/login.ts"], errors: [],
      commits: ["abc1234 fix login redirect"], sessionCount: 1,
      firstActivity: "2026-07-07T09:00:00.000Z", lastActivity: "2026-07-07T09:30:00.000Z",
    },
    narrative: { workedOn: "Fixed login.", completed: "Login fix committed.", inProgress: "Nothing.", blocked: "None.", recommendation: "Review the commit." },
    narrativeSource: "template",
    commits: [{ sha: "abc1234abcdefghijklmnopqrstuvwxyz123456", authorDate: "2026-07-07T09:20:00.000Z", subject: "fix login redirect", attributed: true }],
    ...over,
  };
}

const blocked = agent({ profileId: "codex:/infra", displayName: "infra (codex)", status: "needs_human", severity: "warning", evidence: "claimed_only" });
const report: Report = {
  schemaVersion: 1,
  generatedAt: "2026-07-08T07:00:00.000Z",
  windowStart: "2026-07-07T07:00:00.000Z",
  windowEnd: "2026-07-08T07:00:00.000Z",
  exceptions: [blocked],
  agents: [blocked, agent({})],
};

describe("renderers", () => {
  test("markdown: exceptions first, per-agent sections, evidence labels", () => {
    const md = renderMarkdown(report);
    expect(md.indexOf("## Exceptions")).toBeLessThan(md.indexOf("## Agents"));
    expect(md).toContain("infra (codex)");
    expect(md).toContain("needs_human");
    expect(md).toContain("`abc1234`");
    expect(md).toContain("fix login redirect");
    expect(md).toContain("Evidence: proven");
  });

  test("markdown: unattributed commits shown as labeled repo context", () => {
    const a = agent({
      commits: [
        { sha: "abc1234abcdefghijklmnopqrstuvwxyz123456", authorDate: "2026-07-07T09:20:00.000Z", subject: "fix login redirect", attributed: true },
        { sha: "def5678abcdefghijklmnopqrstuvwxyz123456", authorDate: "2026-07-07T15:00:00.000Z", subject: "human hotfix, not agent work", attributed: false },
      ],
    });
    const md = renderMarkdown({ ...report, agents: [a] });
    expect(md).toContain("Other repo commits (not attributed to this agent):");
    expect(md).toContain("`def5678` human hotfix, not agent work");
    // attributed list must not absorb the unattributed commit
    const attributedBlock = md.slice(md.indexOf("**Commits:**"), md.indexOf("Other repo commits"));
    expect(attributedBlock).not.toContain("def5678");
  });

  test("markdown: no unattributed section when all commits attributed", () => {
    expect(renderMarkdown(report)).not.toContain("Other repo commits");
  });

  test("html: unattributed commits shown, escaped, labeled", () => {
    const a = agent({
      commits: [{ sha: "def5678abcdefghijklmnopqrstuvwxyz123456", authorDate: "2026-07-07T15:00:00.000Z", subject: "hotfix <b>bold</b>", attributed: false }],
    });
    const html = renderHtml({ ...report, agents: [a] });
    expect(html).toContain("Other repo commits");
    expect(html).toContain("def5678");
    expect(html).toContain("hotfix &lt;b&gt;bold&lt;/b&gt;");
    expect(html).not.toContain("<b>bold</b>");
  });

  test("markdown: empty exceptions section says all clear", () => {
    const md = renderMarkdown({ ...report, exceptions: [] });
    expect(md).toContain("No exceptions");
  });

  test("markdown: rollup line summarizes statuses before exceptions", () => {
    const md = renderMarkdown(report);
    expect(md).toContain("2 agents: 1 needs_human, 1 completed");
    expect(md.indexOf("2 agents:")).toBeLessThan(md.indexOf("## Exceptions"));
  });

  test("markdown: rollup counts attributed commits and skips zero statuses", () => {
    const md = renderMarkdown(report);
    expect(md).toContain("2 commits");
    expect(md).not.toContain("0 failed");
    expect(md).not.toContain("0 silent");
  });

  test("markdown: rollup pluralizes counts correctly", () => {
    const md = renderMarkdown({ ...report, agents: [agent({})] });
    expect(md).toContain("1 agent: 1 completed — 1 commit, 1 file touched");
  });

  test("markdown: rollup counts unique files across agents", () => {
    const md = renderMarkdown({ ...report, agents: [agent({}), agent({ profileId: "codex:/w" })] });
    expect(md).toContain("1 file touched");
  });

  test("markdown: empty report gets a plain rollup, not a dangling colon", () => {
    const md = renderMarkdown({ ...report, exceptions: [], agents: [] });
    expect(md).toContain("No agent activity in this window.");
    expect(md).not.toContain("0 agents:");
  });

  test("markdown: unattributed commit list is capped at 5", () => {
    const many = Array.from({ length: 7 }, (_, i) => ({
      sha: `${i}bc1234abcdefghijklmnopqrstuvwxyz123456`,
      authorDate: "2026-07-07T15:00:00.000Z",
      subject: `hotfix ${i}`,
      attributed: false,
    }));
    const md = renderMarkdown({ ...report, agents: [agent({ commits: many })] });
    expect(md).toContain("hotfix 4");
    expect(md).not.toContain("hotfix 5");
    expect(md).toContain("…and 2 more");
  });

  test("html: rollup appears before exceptions", () => {
    const html = renderHtml(report);
    expect(html).toContain("2 agents: 1 needs_human, 1 completed");
    expect(html.indexOf("2 agents:")).toBeLessThan(html.indexOf("Exceptions"));
  });

  test("json: round-trips with schemaVersion", () => {
    const parsed = JSON.parse(renderJson(report));
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.agents.length).toBe(2);
  });

  test("html: self-contained, exceptions before agents, escapes content", () => {
    const nasty = agent({ displayName: "<script>alert(1)</script> (codex)" });
    const html = renderHtml({ ...report, agents: [...report.agents, nasty] });
    expect(html).toContain("<!doctype html>");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toMatch(/src=["']http/);
    expect(html.indexOf("Exceptions")).toBeLessThan(html.indexOf("All agents"));
  });

  test("markdown: trivial profiles footer line", () => {
    const md = renderMarkdown({ ...report, trivialProfiles: ["/ (claude-code)", "tmp (codex)"] });
    expect(md).toContain("Ignored 2 trivial profiles (minimal activity, nothing produced): / (claude-code), tmp (codex)");
  });

  test("markdown: singular trivial profile, and absent field renders nothing", () => {
    expect(renderMarkdown({ ...report, trivialProfiles: ["/ (claude-code)"] })).toContain("Ignored 1 trivial profile (");
    expect(renderMarkdown(report)).not.toContain("Ignored");
  });

  test("html: trivial profiles footer line, escaped", () => {
    const html = renderHtml({ ...report, trivialProfiles: ["<x> (codex)"] });
    expect(html).toContain("Ignored 1 trivial profile");
    expect(html).toContain("&lt;x&gt; (codex)");
  });

  test("html: status badge and evidence label carry tooltip titles", () => {
    const html = renderHtml(report);
    expect(html).toContain(`title="${STATUS_HELP.needs_human}"`);
    expect(html).toContain(`title="${EVIDENCE_HELP.claimed_only}"`);
  });

  test("html: collapsed legend lists every status", () => {
    const html = renderHtml(report);
    expect(html).toContain("<details class=\"legend\">");
    for (const help of Object.values(STATUS_HELP)) expect(html).toContain(help);
  });

  test("markdown: legend section lists every status and evidence level", () => {
    const md = renderMarkdown(report);
    expect(md).toContain("## Legend");
    for (const help of Object.values(STATUS_HELP)) expect(md).toContain(help);
    for (const help of Object.values(EVIDENCE_HELP)) expect(md).toContain(help);
  });
});
