import { describe, expect, test } from "bun:test";
import type { AgentReport, Report } from "../src/types";
import { renderMarkdown } from "../src/render/markdown";
import { renderJson } from "../src/render/json";
import { renderHtml, isHtmlLayout } from "../src/render/html";
import { STATUS_HELP, EVIDENCE_HELP } from "../src/render/legend";
import { FILLER_BLOCKED, FILLER_COMPLETED, FILLER_IN_PROGRESS, FILLER_RECOMMENDATION } from "../src/narrative";
import { redact } from "../src/redact";

function agent(over: Partial<AgentReport>): AgentReport {
  return {
    profileId: "claude-code:/w", displayName: "w (claude-code)", platform: "claude-code", workdir: "/w",
    status: "completed", severity: "info", evidence: "proven",
    facts: {
      titles: ["Fix login bug"], filesTouched: ["/w/src/login.ts"], errors: [],
      commits: ["abc1234 fix login redirect"], sessionCount: 1,
      firstActivity: "2026-07-07T09:00:00.000Z", lastActivity: "2026-07-07T09:30:00.000Z",
    },
    narrative: { workedOn: "Fixed login.", completed: "Login fix committed.", inProgress: "Nothing.", blocked: "None.", recommendation: "Review the commit.", standup: "I fixed the login bug and committed the fix. Nothing is blocking me." },
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
  agents: [agent({}), blocked],
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

  test("markdown: names with markdown metacharacters are escaped in heading, exceptions, and trivial-profiles line", () => {
    const nasty = agent({ displayName: "my_project [wip] *hot* `tick (codex)", status: "needs_human", severity: "warning" });
    const md = renderMarkdown({
      ...report,
      agents: [nasty],
      exceptions: [nasty],
      trivialProfiles: ["under_score (claude-code)"],
    });
    expect(md).toContain("### my\\_project \\[wip\\] \\*hot\\* \\`tick (codex)");
    expect(md).toContain("- **my\\_project \\[wip\\] \\*hot\\* \\`tick (codex)** —");
    expect(md).toContain("under\\_score (claude-code)");
    expect(md).not.toContain("### my_project");
  });

  test("markdown: narrative fields with markdown metacharacters are escaped, not raw", () => {
    const a = agent({
      narrative: {
        ...agent({}).narrative,
        workedOn: "Refactored *auth* and [config](http://x) with `flags`.",
        recommendation: "Review *now* and check [the log](http://x) with `grep`",
      },
    });
    const md = renderMarkdown({ ...report, agents: [a], exceptions: [a] });

    // agentSection site (workedOn)
    expect(md).toContain("**Worked on:** Refactored \\*auth\\* and \\[config\\]\\(http://x\\) with \\`flags\\`.");
    expect(md).not.toContain("**Worked on:** Refactored *auth*");

    // agentSection site (recommendation)
    expect(md).toContain("**Recommended action:** Review \\*now\\* and check \\[the log\\]\\(http://x\\) with \\`grep\\`");
    expect(md).not.toContain("**Recommended action:** Review *now*");

    // exceptions-loop site (recommendation)
    expect(md).toContain("Review \\*now\\* and check \\[the log\\]\\(http://x\\) with \\`grep\\`");
    const exceptionsBlock = md.slice(md.indexOf("## Exceptions"), md.indexOf("## Agents"));
    expect(exceptionsBlock).toContain("Review \\*now\\*");
    expect(exceptionsBlock).not.toContain("Review *now*");
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

  test("markdown: evidenceCitation renders next to the evidence level, md-escaped", () => {
    const a = agent({
      evidence: "partially_proven",
      evidenceCitation: "engram session abc123: observed code edits to /w/src/my_file.ts",
    });
    const md = renderMarkdown({ ...report, agents: [a], exceptions: [] });
    expect(md).toContain("Evidence: partially_proven");
    expect(md).toContain("engram session abc123");
    // underscore in the cited path is escaped so it can't open an emphasis span
    expect(md).toContain("my\\_file.ts");
  });

  test("markdown: no citation line when evidenceCitation is absent", () => {
    expect(renderMarkdown(report)).not.toContain("Evidence citation");
  });

  test("markdown: dispatch lineage renders on both ends, md-escaped, absent otherwise", () => {
    const parent = agent({
      dispatched: [
        { sessionId: "bbbb0000-0000-4000-8000-00000000000b", profile: "my_sub (claude-code)" },
        { sessionId: "cccc0000-0000-4000-8000-00000000000c" }, // profile unresolvable
      ],
    });
    const child = agent({
      profileId: "claude-code:/sub", displayName: "my_sub (claude-code)", workdir: "/sub",
      dispatchedBy: [{ sessionId: "aaaa0000-0000-4000-8000-00000000000a", profile: "w (claude-code)" }],
    });
    const md = renderMarkdown({ ...report, agents: [parent, child], exceptions: [] });
    expect(md).toContain("- Dispatched 2 subagent runs: my\\_sub (claude-code) (session bbbb0000), session cccc0000");
    expect(md).toContain("- Dispatched by: w (claude-code) (session aaaa0000)");
    // baseline report has no lineage fields → no lines
    const plain = renderMarkdown(report);
    expect(plain).not.toContain("Dispatched by");
    expect(plain).not.toContain("subagent run");
  });

  test("html: dispatch lineage renders as dl rows with the dispatch class in both layouts, absent otherwise", () => {
    const parent = agent({
      dispatched: [{ sessionId: "bbbb0000-0000-4000-8000-00000000000b", profile: "sub (claude-code)" }],
    });
    const child = agent({
      profileId: "claude-code:/sub", displayName: "sub (claude-code)", workdir: "/sub",
      dispatchedBy: [{ sessionId: "aaaa0000-0000-4000-8000-00000000000a", profile: "w (claude-code)" }],
    });
    for (const layout of ["cards", "flat"] as const) {
      const html = renderHtml({ ...report, agents: [parent, child], exceptions: [] }, { layout });
      expect(html).toContain(`<dt>Dispatched</dt><dd class="dispatch">1 subagent run: sub (claude-code) (session bbbb0000)</dd>`);
      expect(html).toContain(`<dt>Dispatched by</dt><dd class="dispatch">w (claude-code) (session aaaa0000)</dd>`);
      const plain = renderHtml(report, { layout });
      expect(plain).not.toContain("Dispatched");
    }
  });

  test("html: a hostile profile name in a dispatch ref is escaped", () => {
    const a = agent({
      dispatchedBy: [{ sessionId: "aaaa0000-0000-4000-8000-00000000000a", profile: `<img src=x onerror=alert(1)> (codex)` }],
    });
    const html = renderHtml({ ...report, agents: [a], exceptions: [] });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  test("json: dispatch lineage fields round-trip through the json renderer", () => {
    const a = agent({
      dispatched: [{ sessionId: "bbbb0000-0000-4000-8000-00000000000b", profile: "sub (claude-code)" }],
    });
    const parsed = JSON.parse(renderJson({ ...report, agents: [a], exceptions: [] }));
    expect(parsed.agents[0].dispatched).toEqual([
      { sessionId: "bbbb0000-0000-4000-8000-00000000000b", profile: "sub (claude-code)" },
    ]);
    expect(parsed.agents[0].dispatchedBy).toBeUndefined();
  });

  test("html: evidenceCitation renders in the card, escaped", () => {
    const a = agent({
      evidence: "partially_proven",
      evidenceCitation: 'engram session abc123: edits to /w/src/<b>bold</b>.ts & "quoted"',
    });
    const html = renderHtml({ ...report, agents: [a], exceptions: [] });
    expect(html).toContain('class="evidence-citation"');
    expect(html).toContain("engram session abc123");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(html).not.toContain("<b>bold</b>");
  });

  test("html: no citation markup when evidenceCitation is absent", () => {
    // marker class, not label text: the evidence *badge* renders on every
    // card, so an assertion on generic wording would pass vacuously
    expect(renderHtml(report)).not.toContain("evidence-citation");
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
    expect(html).toContain("2 agents:");
    expect(html.indexOf("2 agents:")).toBeLessThan(html.indexOf("Exceptions"));
  });

  test("html: rollup renders counts as status chips reusing badge styling", () => {
    const html = renderHtml(report);
    const start = html.indexOf('<p class="rollup">');
    const rollup = html.slice(start, html.indexOf("</p>", start));
    expect(rollup).toContain("2 agents:");
    expect(rollup).toContain('class="badge sev-warning"'); // needs_human chip
    expect(rollup).toContain('class="badge sev-info"'); // completed chip
    expect(rollup).toContain("1 needs_human");
    expect(rollup).toContain("1 completed");
    // worst-first, same order as the markdown rollup line
    expect(rollup.indexOf("1 needs_human")).toBeLessThan(rollup.indexOf("1 completed"));
    expect(rollup).toContain("2 commits");
    expect(rollup).toContain("1 file touched"); // both fixtures touch the same file
  });

  test("html: empty report rolls up to a plain sentence, no chips", () => {
    const html = renderHtml({ ...report, exceptions: [], agents: [] });
    expect(html).toContain("No agent activity in this window.");
    expect(html).not.toContain('class="badge"');
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

  test("html: card name is a heading exposed inside summary, badges outside it", () => {
    const html = renderHtml({ ...report, agents: [agent({})] });
    expect(html).toContain('<span class="name" role="heading" aria-level="3">w (claude-code)</span>');
    const cardStart = html.indexOf('<details class="card');
    const summary = html.slice(html.indexOf("<summary>", cardStart), html.indexOf("</summary>", cardStart));
    expect(summary).not.toContain("<h3>");
    // badge tooltip text must not pollute the heading's accessible name
    const heading = summary.slice(summary.indexOf('role="heading"'), summary.indexOf("</span>"));
    expect(heading).not.toContain("badge");
  });

  test("html: flat layout keeps real h3 headings, no role attributes", () => {
    const flat = renderHtml(report, { layout: "flat" });
    expect(flat).toContain("<h3>w (claude-code)</h3>");
    expect(flat).not.toContain('role="heading"');
  });

  test("html: legend sits directly under the rollup chips, above exceptions", () => {
    for (const layout of ["cards", "flat"] as const) {
      const html = renderHtml(report, { layout });
      const legend = html.indexOf('<details class="legend">');
      expect(legend).toBeGreaterThan(html.indexOf('class="rollup"'));
      expect(legend).toBeLessThan(html.indexOf("<h2>Exceptions</h2>"));
    }
  });

  test("html: badges carry a discoverable abbr-like help affordance", () => {
    const rule = cssRule(renderHtml(report), ".badge[title], .evidence[title]");
    expect(rule).toContain("underline");
    expect(rule).toContain("dotted");
    expect(rule).toContain("cursor: help");
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

  test("markdown: standup blurb is an italic lead line right after the agent heading", () => {
    const md = renderMarkdown(report);
    expect(md).toContain("_I fixed the login bug and committed the fix. Nothing is blocking me._");
    const section = md.slice(md.indexOf("### w (claude-code)"));
    expect(section.indexOf("_I fixed the login bug")).toBeLessThan(section.indexOf("- Status:"));
  });

  test("markdown: standup with newlines collapses to one lead line", () => {
    const a = agent({ narrative: { ...agent({}).narrative, standup: "I did things.\nThen more\n\nthings." } });
    const md = renderMarkdown({ ...report, agents: [a] });
    expect(md).toContain("_I did things. Then more things._");
  });

  test("markdown: standup underscores are escaped so italics survive", () => {
    const a = agent({ narrative: { ...agent({}).narrative, standup: "I renamed foo_bar to baz_qux." } });
    const md = renderMarkdown({ ...report, agents: [a] });
    expect(md).toContain("_I renamed foo\\_bar to baz\\_qux._");
  });

  test("markdown: standup raw HTML is escaped to plain text", () => {
    const a = agent({ narrative: { ...agent({}).narrative, standup: "I shipped <img src=x onerror=alert(1)> today." } });
    const md = renderMarkdown({ ...report, agents: [a] });
    expect(md).toContain("\\<img src=x onerror=alert\\(1\\)\\>");
  });

  test("html: default layout renders details/summary standup cards in a grid", () => {
    const html = renderHtml({ ...report, agents: [agent({})] });
    expect(html).toContain('<div class="cards">');
    expect(html).toContain('<details class="card');
    expect(html).not.toContain('<article class="card');
    expect(html).toContain(".cards {");
    // summary (card front) carries the blurb; full detail is behind it
    const cardStart = html.indexOf('<details class="card');
    const summary = html.slice(html.indexOf("<summary>", cardStart), html.indexOf("</summary>", cardStart));
    expect(summary).toContain("I fixed the login bug and committed the fix.");
    expect(summary).toContain("w (claude-code)");
    const card = html.slice(cardStart, html.indexOf("</details>", cardStart));
    expect(card).toContain("<dt>Worked on</dt>");
  });

  test("html: every card carries a severity class driving a colored left edge in both layouts", () => {
    for (const layout of ["cards", "flat"] as const) {
      const html = renderHtml(report, { layout });
      expect(html).toContain("card sev-warning"); // warning card
      expect(html).toContain("card sev-info"); // info card
      // The colored edge is one CSS rule consuming the class's --sev property.
      expect(cssRule(html, ".card")).toContain("border-left: 3px solid var(--sev)");
      expect(cssRule(html, ".sev-warning")).toContain("--sev: #8a6d00");
      expect(cssRule(html, ".sev-info")).toContain("--sev: #2d7a46");
      expect(cssRule(html, ".sev-urgent")).toContain("--sev: #c0392b");
    }
  });

  test("html: cards layout splits needs-attention from FYI when both exist", () => {
    const html = renderHtml(report); // one warning agent, one info agent
    expect(html).toContain("Needs attention");
    expect(html).toContain("FYI");
    expect(html.indexOf("Needs attention")).toBeLessThan(html.indexOf("FYI"));
    expect(html.match(/<div class="cards">/g)?.length).toBe(2);
  });

  test("html: no triage group labels when only one kind exists", () => {
    const allInfo = renderHtml({ ...report, exceptions: [], agents: [agent({})] });
    expect(allInfo).not.toContain("Needs attention");
    expect(allInfo).not.toContain("FYI");
    const allWarn = renderHtml({ ...report, agents: [blocked] });
    expect(allWarn).not.toContain("Needs attention");
    expect(allWarn).not.toContain("FYI");
  });

  test("html: flat layout keeps the severity edge but no triage grouping", () => {
    const flat = renderHtml(report, { layout: "flat" });
    expect(flat).toContain('<article class="card sev-warning">');
    expect(cssRule(flat, ".card")).toContain("border-left: 3px solid var(--sev)");
    expect(flat).not.toContain("Needs attention");
    expect(flat).not.toContain("FYI");
  });

  test("html: --layout flat renders the legacy article cards, no collapsible agents", () => {
    const html = renderHtml(report, { layout: "flat" });
    expect(html).toContain('<article class="card');
    expect(html).not.toContain('<details class="card');
    expect(html).toContain("<dt>Worked on</dt>");
    expect(html).toContain('<details class="legend">'); // legend stays collapsible
    expect(html).not.toContain(".cards {");
    expect(html).not.toContain("details.card");
  });

  // Extract a single CSS rule body from the rendered <style> block.
  function cssRule(html: string, selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = html.match(new RegExp(`^${escaped} \\{([^}]*)\\}`, "m"));
    if (!m) throw new Error(`no CSS rule for selector: ${selector}`);
    return m[1]!;
  }

  test("html: cards layout CSS breaks long unbroken tokens inside cards and exceptions", () => {
    const html = renderHtml(report);
    expect(cssRule(html, ".card")).toContain("overflow-wrap: anywhere");
    expect(cssRule(html, ".exceptions")).toContain("overflow-wrap: anywhere");
  });

  test("html: flat layout CSS breaks long unbroken tokens inside cards and exceptions", () => {
    const html = renderHtml(report, { layout: "flat" });
    expect(cssRule(html, ".card")).toContain("overflow-wrap: anywhere");
    expect(cssRule(html, ".exceptions")).toContain("overflow-wrap: anywhere");
  });

  test("html: dl grid column clamps min-content so long dd tokens cannot widen the card", () => {
    for (const layout of ["cards", "flat"] as const) {
      expect(cssRule(renderHtml(report, { layout }), "dl")).toContain("8rem minmax(0, 1fr)");
    }
  });

  test("html: cards layout summary shows a chevron affordance and hover cue", () => {
    const html = renderHtml(report);
    expect(cssRule(html, "details.card > summary::after")).toContain('"▸"');
    expect(cssRule(html, "details.card[open] > summary::after")).toContain('"▾"');
    expect(cssRule(html, "details.card > summary:hover")).toContain("background: #8881");
  });

  test("html: warning badge gold and error red meet AA contrast", () => {
    const html = renderHtml(report);
    // Gold now lives once in the .sev-warning rule; the badge paints it via --sev.
    expect(cssRule(html, ".sev-warning")).toContain("--sev: #8a6d00");
    expect(cssRule(html, ".badge")).toContain("background: var(--sev)");
    expect(html).not.toContain("#b8860b");
    expect(cssRule(html, ".errors li")).toContain("light-dark(#c0392b, #e07b6c)");
  });

  test("html: cards layout narrows dl labels to 6rem uppercase; flat keeps 8rem", () => {
    const html = renderHtml(report);
    expect(cssRule(html, ".cards dl")).toContain("6rem minmax(0, 1fr)");
    const dt = cssRule(html, ".cards dt");
    expect(dt).toContain("font-size: .8rem");
    expect(dt).toContain("text-transform: uppercase");
    expect(renderHtml(report, { layout: "flat" })).not.toContain(".cards dl");
  });

  test("html: body max-width admits a third card column on wide screens", () => {
    expect(cssRule(renderHtml(report), "body")).toContain("max-width: 80rem");
  });

  test("html: window and footer timestamps are human-readable UTC, full ISO in title", () => {
    const html = renderHtml(report);
    expect(html).toContain("Jul 7, 07:00 → Jul 8, 07:00 UTC");
    expect(html).toContain('title="2026-07-07T07:00:00.000Z → 2026-07-08T07:00:00.000Z"');
    expect(html).toContain("Generated Jul 8, 07:00 UTC");
    expect(html).toContain('title="2026-07-08T07:00:00.000Z"');
    // raw ISO strings live only in title attributes, never as visible text
    expect(html).not.toContain(">2026-07-07T07:00:00.000Z");
  });

  test("html: standup blurb is upright with a quote-bar, not italic", () => {
    const standup = cssRule(renderHtml(report), "details.card .standup");
    expect(standup).not.toContain("italic");
    expect(standup).toContain("border-left: 2px solid #8884");
    expect(standup).toContain("opacity: .85");
  });

  test("html: exception-severity cards render open; info cards stay collapsed", () => {
    const html = renderHtml(report); // one info agent, one warning agent
    const open = html.match(/<details class="card[^>]*\bopen\b/g) ?? [];
    const all = html.match(/<details class="card/g) ?? [];
    expect(all.length).toBe(2);
    expect(open.length).toBe(1);
  });

  test("html: flat card header wraps badges under long display names", () => {
    const header = cssRule(renderHtml(report, { layout: "flat" }), ".card header");
    expect(header).toContain("flex-wrap: wrap");
    // row-gap must come AFTER the gap shorthand — gap resets row-gap, so the
    // reverse order silently loses the tighter wrap spacing.
    expect(header.indexOf("row-gap: .25rem")).toBeGreaterThan(header.indexOf("gap: .6rem"));
    expect(header).toContain("row-gap: .25rem");
  });

  // A quiet, claimed-only agent: no commits, files, or errors, and every
  // collapsible narrative field is the exact template filler.
  function quietAgent(): AgentReport {
    return agent({
      evidence: "claimed_only",
      facts: { ...agent({}).facts, filesTouched: [], errors: [], commits: [] },
      commits: [],
      narrative: {
        workedOn: "1 session: untitled work.",
        completed: FILLER_COMPLETED,
        inProgress: FILLER_IN_PROGRESS,
        blocked: FILLER_BLOCKED,
        recommendation: FILLER_RECOMMENDATION,
        standup: "I worked on untitled work across 1 session. Nothing is blocking me.",
      },
    });
  }

  test("html: fully quiet card collapses filler rows into one dimmed line", () => {
    for (const layout of ["cards", "flat"] as const) {
      const html = renderHtml({ ...report, exceptions: [], agents: [quietAgent()] }, { layout });
      expect(html).toContain("Nothing completed, in progress, or blocked.");
      expect(html).toContain("<dt>Worked on</dt>");
      expect(html).not.toContain("<dt>Completed</dt>");
      expect(html).not.toContain("<dt>In progress</dt>");
      expect(html).not.toContain("<dt>Blocked</dt>");
      expect(html).not.toContain("<dt>Next</dt>");
      expect(cssRule(html, ".filler")).toContain("opacity: .5");
    }
  });

  test("html: partially quiet card skips only its template filler rows", () => {
    const a = agent({ narrative: { ...agent({}).narrative, inProgress: FILLER_IN_PROGRESS, blocked: FILLER_BLOCKED } });
    const html = renderHtml({ ...report, exceptions: [], agents: [a] });
    expect(html).toContain("<dt>Completed</dt>"); // backed by a real commit
    expect(html).toContain("<dt>Next</dt>");
    expect(html).not.toContain("<dt>In progress</dt>");
    expect(html).not.toContain("<dt>Blocked</dt>");
    expect(html).not.toContain("Nothing completed, in progress, or blocked");
  });

  test("html: LLM narrative text renders even when backing facts are empty", () => {
    const a = agent({
      facts: { ...agent({}).facts, filesTouched: [], errors: [], commits: [] },
      commits: [],
      narrative: {
        ...agent({}).narrative,
        completed: "Wrapped up the refactor cleanly.",
        inProgress: "Reviewing edge cases.",
        blocked: "Waiting on CI quota.",
      },
    });
    const html = renderHtml({ ...report, exceptions: [], agents: [a] });
    expect(html).toContain("<dt>Completed</dt>");
    expect(html).toContain("Wrapped up the refactor cleanly.");
    expect(html).toContain("<dt>Blocked</dt>");
    expect(html).not.toContain("Nothing completed, in progress, or blocked");
  });

  test("html: filler-shaped text with non-empty backing facts still renders", () => {
    const a = agent({
      narrative: { ...agent({}).narrative, completed: FILLER_COMPLETED, blocked: FILLER_BLOCKED },
      facts: { ...agent({}).facts, errors: ["boom — something bad"] },
    });
    const html = renderHtml({ ...report, exceptions: [], agents: [a] });
    expect(html).toContain("<dt>Completed</dt>"); // facts.commits is non-empty
    expect(html).toContain("<dt>Blocked</dt>"); // facts.errors is non-empty
  });

  test("html: error lines split reason from tool payload at the withContext marker", () => {
    const a = agent({ facts: { ...agent({}).facts, errors: ["exit code 143 — while Bash: rm -rf <dir>"] } });
    const html = renderHtml({ ...report, exceptions: [], agents: [a] });
    expect(html).toContain('<li>exit code 143<code class="error-ctx">Bash: rm -rf &lt;dir&gt;</code></li>');
    expect(html).not.toContain(" — while Bash");
    const rule = cssRule(html, ".errors li > code");
    expect(rule).toContain("display: block");
    expect(rule).toContain("overflow-x: auto");
    expect(rule).toContain("white-space: pre-wrap");
    expect(rule).toContain("font-size: .75rem");
    expect(rule).toContain("opacity: .8");
  });

  test("html: error lines without the marker render as before, escaped", () => {
    const a = agent({ facts: { ...agent({}).facts, errors: ["plain <error> line"] } });
    const html = renderHtml({ ...report, exceptions: [], agents: [a] });
    expect(html).toContain("<li>plain &lt;error&gt; line</li>");
    expect(html).not.toContain("error-ctx");
  });

  test("html: file paths dim the directory prefix so the basename pops", () => {
    const a = agent({ facts: { ...agent({}).facts, filesTouched: ["/w/src/deep/login.ts", "README.md"] } });
    const html = renderHtml({ ...report, exceptions: [], agents: [a] });
    expect(html).toContain('<code><span class="dir">/w/src/deep/</span>login.ts</code>');
    expect(html).toContain("<code>README.md</code>"); // no dir → no wrapper
    expect(cssRule(html, ".dir")).toContain("opacity: .6");
  });

  test("html: dimmed file paths stay escaped", () => {
    const a = agent({ facts: { ...agent({}).facts, filesTouched: ["/w/<x>/e&.ts"] } });
    const html = renderHtml({ ...report, exceptions: [], agents: [a] });
    expect(html).toContain('<span class="dir">/w/&lt;x&gt;/</span>e&amp;.ts');
    expect(html).not.toContain("<x>");
  });

  test("markdown: agent trends render as a Trend fact line; absent field renders nothing", () => {
    const a = agent({ status: "silent", severity: "urgent", trends: ["also silent yesterday", "0 commits vs 3 yesterday (-3)"] });
    const md = renderMarkdown({ ...report, agents: [a] });
    expect(md).toContain("- Trend: also silent yesterday; 0 commits vs 3 yesterday (-3)");
    expect(renderMarkdown(report)).not.toContain("- Trend:");
  });

  test("markdown: report-level trends line sits under the rollup", () => {
    const md = renderMarkdown({ ...report, trends: ["2 commits vs 5 yesterday (-3)"] });
    expect(md).toContain("Trends: 2 commits vs 5 yesterday (-3)");
    expect(md.indexOf("2 agents:")).toBeLessThan(md.indexOf("Trends:"));
    expect(md.indexOf("Trends:")).toBeLessThan(md.indexOf("## Exceptions"));
    expect(renderMarkdown(report)).not.toContain("Trends:");
  });

  test("html: agent trends render a Trend row in both layouts; absent renders nothing", () => {
    const a = agent({ trends: ["1 recurring error (also seen yesterday)"] });
    for (const layout of ["cards", "flat"] as const) {
      const html = renderHtml({ ...report, agents: [a] }, { layout });
      expect(html).toContain("<dt>Trend</dt><dd>1 recurring error (also seen yesterday)</dd>");
      expect(renderHtml(report, { layout })).not.toContain("<dt>Trend</dt>");
    }
  });

  test("html: report-level trends line sits under the rollup, escaped", () => {
    const html = renderHtml({ ...report, trends: ["2 commits vs 5 yesterday (-3)", "<x>"] });
    expect(html).toContain("Trends: 2 commits vs 5 yesterday (-3); &lt;x&gt;");
    expect(html.indexOf('class="rollup"')).toBeLessThan(html.indexOf("Trends:"));
    expect(html.indexOf("Trends:")).toBeLessThan(html.indexOf('<details class="legend">'));
    expect(renderHtml(report)).not.toContain("Trends:");
  });

  test("html: standup blurb is escaped", () => {
    const a = agent({ narrative: { ...agent({}).narrative, standup: "I <b>bolded</b> things." } });
    const html = renderHtml({ ...report, agents: [a] });
    expect(html).toContain("I &lt;b&gt;bolded&lt;/b&gt; things.");
    expect(html).not.toContain("<b>bolded</b>");
  });

  test("html: standup blurb flows through redaction like all rendered output", () => {
    const a = agent({ narrative: { ...agent({}).narrative, standup: "I set api_key=hunter2secret and moved on." } });
    const html = redact(renderHtml({ ...report, agents: [a] }));
    expect(html).toContain("[REDACTED]");
    expect(html).not.toContain("hunter2secret");
  });

  test("html: status badge carries the severity class, no inline style", () => {
    const html = renderHtml({ ...report, agents: [blocked] }); // needs_human = warning
    expect(html).toContain('<span class="badge sev-warning" title=');
    expect(html).not.toContain('style="background:');
  });

  test("html: a pathologically long standup blurb is capped with an ellipsis on the card front", () => {
    const long = "x".repeat(500);
    const a = agent({ narrative: { ...agent({}).narrative, standup: long } });
    const html = renderHtml({ ...report, exceptions: [], agents: [a] });
    const cardStart = html.indexOf('<details class="card');
    const summary = html.slice(html.indexOf("<summary>", cardStart), html.indexOf("</summary>", cardStart));
    const blurb = summary.slice(summary.indexOf('<span class="standup">') + '<span class="standup">'.length, summary.indexOf("</span>", summary.indexOf('<span class="standup">')));
    expect(blurb.endsWith("…")).toBe(true);
    expect(blurb.length).toBeLessThanOrEqual(281); // 280-char cap + the ellipsis
    expect(blurb.length).toBeLessThan(long.length);
  });

  test("html: a short standup blurb passes through unchanged, no ellipsis", () => {
    const short = "All done, nothing blocking.";
    const a = agent({ narrative: { ...agent({}).narrative, standup: short } });
    const html = renderHtml({ ...report, exceptions: [], agents: [a] });
    expect(html).toContain(`<span class="standup">${short}</span>`);
    expect(html).not.toContain("…");
  });

  test("isHtmlLayout narrows valid layout strings and rejects others", () => {
    expect(isHtmlLayout("cards")).toBe(true);
    expect(isHtmlLayout("flat")).toBe(true);
    expect(isHtmlLayout("grid")).toBe(false);
    expect(isHtmlLayout("")).toBe(false);
  });
});
