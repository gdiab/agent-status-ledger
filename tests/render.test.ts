import { describe, expect, test } from "bun:test";
import type { AgentReport, Report } from "../src/types";
import type { SanitizedTapeText } from "../src/redact";
import { renderMarkdown } from "../src/render/markdown";
import { renderJson } from "../src/render/json";
import { renderHtml, isHtmlLayout } from "../src/render/html";
import { STATUS_HELP, EVIDENCE_HELP } from "../src/render/legend";
import { plural, pluralWord } from "../src/render/rollup";
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
      // Deliberately forged brand: these tests pin renderer-side escaping as
      // an INDEPENDENT defense layer (asl-xis), so the fixture must be a raw
      // string the real choke point would already have neutralized.
      evidenceCitation: "engram session abc123: observed code edits to /w/src/my_file.ts" as SanitizedTapeText,
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

  test("markdown: interactionKind and awaitingQuestion render on the card, md-escaped, absent otherwise", () => {
    const a = agent({
      status: "needs_human", severity: "warning",
      interactionKind: "thinking",
      // Forged brand (see the citation tests): renderer-side escaping is its
      // own defense layer, so the fixture carries raw markdown metachars.
      awaitingQuestion: "keep my_file.ts or [roll back]?" as SanitizedTapeText,
    });
    const md = renderMarkdown({ ...report, agents: [a], exceptions: [] });
    expect(md).toContain("- Session kind: thinking help (dialogue only, no build activity observed)");
    expect(md).toContain("- Waiting on: “keep my\\_file.ts or \\[roll back\\]?”");
    // absent fields → absent lines
    const bare = renderMarkdown(report);
    expect(bare).not.toContain("Session kind");
    expect(bare).not.toContain("Waiting on");
  });

  test("markdown: exception triage line carries the awaiting question, md-escaped, absent otherwise", () => {
    const waiting = agent({
      status: "needs_human", severity: "warning",
      // Forged brand (see the citation tests): renderer-side escaping is its
      // own defense layer, so the fixture carries raw markdown metachars.
      awaitingQuestion: "keep my_file.ts or [roll back]?" as SanitizedTapeText,
    });
    const md = renderMarkdown({ ...report, agents: [waiting], exceptions: [waiting] });
    const exceptionsBlock = md.slice(md.indexOf("## Exceptions"), md.indexOf("## Agents"));
    expect(exceptionsBlock).toContain("— Waiting on: “keep my\\_file.ts or \\[roll back\\]?”");
    // an exception agent without a question keeps the plain triage line
    const bare = renderMarkdown(report);
    const bareBlock = bare.slice(bare.indexOf("## Exceptions"), bare.indexOf("## Agents"));
    expect(bareBlock).not.toContain("Waiting on");
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

  test("markdown+html: dispatchTruncated appends the incomplete-list suffix to the dispatched line only when set", () => {
    const dispatched = [{ sessionId: "bbbb0000-0000-4000-8000-00000000000b", profile: "sub (claude-code)" }];
    const truncated = agent({ dispatched, dispatchTruncated: true });
    const complete = agent({ dispatched });

    const mdTruncated = renderMarkdown({ ...report, agents: [truncated], exceptions: [] });
    expect(mdTruncated).toContain("- Dispatched 1 subagent run: sub (claude-code) (session bbbb0000) (list may be incomplete)");
    const mdComplete = renderMarkdown({ ...report, agents: [complete], exceptions: [] });
    expect(mdComplete).toContain("- Dispatched 1 subagent run: sub (claude-code) (session bbbb0000)");
    expect(mdComplete).not.toContain("list may be incomplete");

    for (const layout of ["cards", "flat"] as const) {
      const htmlTruncated = renderHtml({ ...report, agents: [truncated], exceptions: [] }, { layout });
      expect(htmlTruncated).toContain(`<dt>Dispatched</dt><dd class="dispatch">1 subagent run: sub (claude-code) (session bbbb0000) (list may be incomplete)</dd>`);
      const htmlComplete = renderHtml({ ...report, agents: [complete], exceptions: [] }, { layout });
      expect(htmlComplete).not.toContain("list may be incomplete");
    }
  });

  test("markdown+html: zero-link truncation still renders an incomplete-list line", () => {
    // A truncated probe that found no links must be distinguishable from an
    // exhaustive "no dispatches" — silence on two of three surfaces was a
    // review finding.
    const truncatedNoLinks = agent({ dispatchTruncated: true });
    const noProbe = agent({});

    const md = renderMarkdown({ ...report, agents: [truncatedNoLinks], exceptions: [] });
    expect(md).toContain("- Dispatched subagent runs: none identified (list may be incomplete)");
    const mdPlain = renderMarkdown({ ...report, agents: [noProbe], exceptions: [] });
    expect(mdPlain).not.toContain("Dispatched");

    for (const layout of ["cards", "flat"] as const) {
      const html = renderHtml({ ...report, agents: [truncatedNoLinks], exceptions: [] }, { layout });
      expect(html).toContain(`<dt>Dispatched</dt><dd class="dispatch">subagent runs: none identified (list may be incomplete)</dd>`);
      const htmlPlain = renderHtml({ ...report, agents: [noProbe], exceptions: [] }, { layout });
      expect(htmlPlain).not.toContain("Dispatched");
    }
  });

  test("markdown+html: in-session runs render as a count, alone and alongside named refs", () => {
    // In-session subagent runs (Task tool) share the dispatching session's
    // harness id, so there's no session to name — the count is the fact.
    const runsOnly = agent({ dispatchedRuns: 2 });
    const mixed = agent({
      dispatched: [{ sessionId: "bbbb0000-0000-4000-8000-00000000000b", profile: "sub (claude-code)" }],
      dispatchedRuns: 2,
    });

    const mdRuns = renderMarkdown({ ...report, agents: [runsOnly], exceptions: [] });
    expect(mdRuns).toContain("- Dispatched 2 subagent runs: 2 in-session runs");
    const mdMixed = renderMarkdown({ ...report, agents: [mixed], exceptions: [] });
    expect(mdMixed).toContain("- Dispatched 3 subagent runs: sub (claude-code) (session bbbb0000), 2 in-session runs");

    for (const layout of ["cards", "flat"] as const) {
      const htmlRuns = renderHtml({ ...report, agents: [runsOnly], exceptions: [] }, { layout });
      expect(htmlRuns).toContain(`<dt>Dispatched</dt><dd class="dispatch">2 subagent runs: 2 in-session runs</dd>`);
      const htmlMixed = renderHtml({ ...report, agents: [mixed], exceptions: [] }, { layout });
      expect(htmlMixed).toContain(`<dt>Dispatched</dt><dd class="dispatch">3 subagent runs: sub (claude-code) (session bbbb0000), 2 in-session runs</dd>`);
    }
  });

  test("markdown: a truncated in-session run count carries the incomplete-list suffix", () => {
    const a = agent({ dispatchedRuns: 1, dispatchTruncated: true });
    const md = renderMarkdown({ ...report, agents: [a], exceptions: [] });
    expect(md).toContain("- Dispatched 1 subagent run: 1 in-session run (list may be incomplete)");
  });

  test("json: dispatchedRuns rides the agent natively", () => {
    const a = agent({ dispatchedRuns: 3 });
    const parsed = JSON.parse(renderJson({ ...report, agents: [a], exceptions: [] }));
    expect(parsed.agents[0].dispatchedRuns).toBe(3);
    const plain = JSON.parse(renderJson(report));
    expect(plain.agents[0].dispatchedRuns).toBeUndefined();
  });

  test("json: dispatchTruncated rides the agent natively", () => {
    const a = agent({
      dispatched: [{ sessionId: "bbbb0000-0000-4000-8000-00000000000b", profile: "sub (claude-code)" }],
      dispatchTruncated: true,
    });
    const parsed = JSON.parse(renderJson({ ...report, agents: [a], exceptions: [] }));
    expect(parsed.agents[0].dispatchTruncated).toBe(true);
    const plain = JSON.parse(renderJson(report));
    expect(plain.agents[0].dispatchTruncated).toBeUndefined();
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
      // Forged brand, same rationale as the markdown citation test: the raw
      // "<b>" must exist in the fixture for the escaping assertion to bite.
      evidenceCitation: 'engram session abc123: edits to /w/src/<b>bold</b>.ts & "quoted"' as SanitizedTapeText,
    });
    const html = renderHtml({ ...report, agents: [a], exceptions: [] });
    expect(html).toContain('class="evidence-citation"');
    expect(html).toContain("engram session abc123");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(html).not.toContain("<b>bold</b>");
  });

  test("html: interactionKind and awaitingQuestion render as card rows, escaped, absent otherwise", () => {
    const a = agent({
      status: "needs_human", severity: "warning",
      interactionKind: "build",
      awaitingQuestion: 'merge the "big" branch & <tag> it?' as SanitizedTapeText, // forged brand, raw chars on purpose
    });
    const html = renderHtml({ ...report, agents: [a], exceptions: [] });
    expect(html).toContain('<dt>Session kind</dt><dd class="interaction-kind">build work (code edits or tool activity observed in dialogue)</dd>');
    expect(html).toContain('class="awaiting-question"');
    expect(html).toContain("&lt;tag&gt;");
    expect(html).not.toContain("<tag>");
    const bare = renderHtml(report);
    expect(bare).not.toContain("interaction-kind");
    expect(bare).not.toContain("awaiting-question");
  });

  test("html: exception li carries the awaiting question, escaped, absent otherwise", () => {
    const waiting = agent({
      status: "needs_human", severity: "warning",
      awaitingQuestion: 'merge the "big" branch & <tag> it?' as SanitizedTapeText, // forged brand, raw chars on purpose
    });
    const html = renderHtml({ ...report, agents: [waiting], exceptions: [waiting] });
    const exceptionsBlock = html.slice(html.indexOf("<h2>Exceptions</h2>"), html.indexOf("All agents"));
    expect(exceptionsBlock).toContain('— Waiting on: <span class="awaiting-question">“merge the &quot;big&quot; branch &amp; &lt;tag&gt; it?”</span>');
    expect(exceptionsBlock).not.toContain("<tag>");
    // an exception agent without a question keeps the plain triage li
    const bare = renderHtml(report);
    const bareBlock = bare.slice(bare.indexOf("<h2>Exceptions</h2>"), bare.indexOf("All agents"));
    expect(bareBlock).not.toContain("awaiting-question");
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

  test("pluralWord is the word-form seam plural is built on", () => {
    expect(pluralWord(1, "commit")).toBe("commit");
    expect(pluralWord(2, "commit")).toBe("commits");
    expect(pluralWord(0, "file")).toBe("files");
    expect(plural(1, "file")).toBe(`1 ${pluralWord(1, "file")}`);
    expect(plural(3, "file")).toBe(`3 ${pluralWord(3, "file")}`);
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
    expect(html).toContain('<div class="rollup-strip">');
    expect(html.indexOf('class="rollup-strip"')).toBeLessThan(html.indexOf("Exceptions"));
  });

  test("html: rollup renders as a labeled stat strip, status chips reusing badge styling", () => {
    const html = renderHtml(report);
    const start = html.indexOf('<div class="rollup-strip">');
    const strip = html.slice(start, html.indexOf("\n", start));
    // four labeled segments in fixed order: Agents → Platforms → Status → Output
    const labels = [...strip.matchAll(/<span class="seg-label">([^<]+)<\/span>/g)].map((m) => m[1]);
    expect(labels).toEqual(["Agents", "Platforms", "Status", "Output"]);
    expect(strip.match(/<div class="seg">/g)?.length).toBe(4);
    // agent count is a bare mono value under its eyebrow, no "agents:" prose
    expect(strip).toContain('<span class="seg-label">Agents</span><span class="seg-value">2</span>');
    expect(strip).not.toContain("agents:");
    // status chips reuse statusBadge classes/labels, worst-first
    expect(strip).toContain('class="badge st-needs_human"');
    expect(strip).toContain("1 needs_human");
    expect(strip).toContain('class="badge st-completed"');
    expect(strip.indexOf("1 needs_human")).toBeLessThan(strip.indexOf("1 completed"));
    // output counts: bare numbers with muted unit words, plural/singular correct
    expect(strip).toContain('2 <span class="unit">commits</span>');
    expect(strip).toContain('1 <span class="unit">file</span>'); // both fixtures touch the same file
  });

  test("html: strip values are mono; seg-label joins the shared eyebrow rule; wrap-safe hairline dividers", () => {
    const html = renderHtml(report);
    const value = cssRule(html, ".rollup-strip .seg-value");
    expect(value).toContain("font-family: var(--font-mono)");
    expect(value).toContain("color: var(--fg-1)");
    expect(cssRule(html, ".rollup-strip .seg-value .unit")).toContain("color: var(--fg-3)");
    // Wrap-safe dividers: spacing via gap, every seg draws a ::before line
    // offset into the gap, and the strip clips row-leading dividers at its
    // edge. A border-left divider would dangle on wrapped rows, so the old
    // border-left/:first-child pair must stay gone.
    const strip = cssRule(html, ".rollup-strip");
    expect(strip).toContain("column-gap: calc(2 * var(--space-5))");
    expect(strip).toContain("row-gap: var(--space-3)");
    expect(strip).toContain("overflow: hidden");
    expect(strip).toContain("margin: var(--space-4) 0 0"); // masthead placement matches the old .rollup rule
    const divider = cssRule(html, ".rollup-strip .seg::before");
    expect(divider).toContain("position: absolute");
    expect(divider).toContain("left: calc(-1 * var(--space-5))"); // centered in the gap
    expect(divider).toContain("width: 1px");
    expect(divider).toContain("background: var(--border-1)");
    expect(cssRule(html, ".rollup-strip .seg")).toContain("position: relative");
    expect(cssRule(html, ".rollup-strip .seg")).not.toContain("border-left");
    expect(html).not.toContain(".rollup-strip .seg:first-child");
  });

  test("html: empty report rolls up to a plain sentence, no chips, no strip", () => {
    const html = renderHtml({ ...report, exceptions: [], agents: [] });
    expect(html).toContain('<p class="rollup">No agent activity in this window.</p>');
    expect(html).not.toContain('class="badge"');
    // strip CSS is static, but no strip markup renders for an empty report
    expect(html).not.toContain('<div class="rollup-strip">');
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
      expect(legend).toBeGreaterThan(html.indexOf('class="rollup-strip"'));
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

  test("html: cards are hairline surfaces with token badge pairs, no severity side stripe", () => {
    for (const layout of ["cards", "flat"] as const) {
      const html = renderHtml(report, { layout });
      expect(html).toContain("card sev-warning"); // severity class stays a container hook
      expect(html).toContain("card sev-info");
      // Side-stripe ban (DESIGN.md §6): hairline card, no colored left edge.
      const card = cssRule(html, ".card");
      expect(card).toContain("border: 1px solid var(--border-1)");
      expect(card).toContain("background: var(--bg-1)");
      expect(card).toContain("border-radius: var(--radius-lg)");
      expect(html).not.toContain("border-left: 3px");
      // Urgent containers get the full danger-subtle tint (asl-ec7 §8 Q6).
      expect(cssRule(html, ".card.sev-urgent, .thread.sev-urgent")).toContain("background: var(--danger-subtle)");
      // Badges color by status via the theme's subtle pairs.
      expect(cssRule(html, ".st-needs_human")).toContain("background: var(--warning-subtle)");
      expect(cssRule(html, ".st-needs_human")).toContain("color: var(--warning-subtle-fg)");
      expect(cssRule(html, ".st-failed")).toContain("background: var(--danger-subtle)");
      expect(cssRule(html, ".st-completed")).toContain("background: var(--success-subtle)");
    }
  });

  test("html: silent badge is hollow warning amber; failed stays filled danger", () => {
    const html = renderHtml(report);
    // §8 Q2: silent reads as caution (hollow dot, warning hue), display only —
    // its severity stays urgent. failed keeps the filled danger dot.
    expect(cssRule(html, ".st-silent")).toContain("--dot: var(--warning)");
    expect(cssRule(html, ".st-silent .dot")).toContain("background: transparent");
    expect(cssRule(html, ".st-silent .dot")).toContain("border: 1.5px solid var(--dot)");
    expect(cssRule(html, ".st-failed")).toContain("--dot: var(--danger)");
    expect(html).not.toContain(".st-failed .dot");
  });

  test("html: active badge is a Signal Green dot with a neutral word, never a green fill", () => {
    const html = renderHtml(report);
    // One Signal Rule (DESIGN.md §2): accent marks live state via the dot only.
    const active = cssRule(html, ".st-active");
    expect(active).toContain("background: transparent");
    expect(active).toContain("color: var(--fg-2)");
    expect(active).toContain("--dot: var(--accent)");
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

  test("html: flat layout keeps the severity container class but no triage grouping", () => {
    const flat = renderHtml(report, { layout: "flat" });
    expect(flat).toContain('<article class="card sev-warning">');
    expect(cssRule(flat, ".card")).toContain("border: 1px solid var(--border-1)");
    expect(flat).not.toContain("border-left: 3px");
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
    const marker = cssRule(html, "details.card > summary::after");
    expect(marker).toContain('"▸"');
    expect(marker).toContain("color: var(--fg-4)"); // dimmed to the ink-ramp floor
    expect(cssRule(html, "details.card[open] > summary::after")).toContain('"▾"');
    // Interaction states: hover steps the surface, focus rings with the accent.
    // Outline (not box-shadow) so the ring survives forced-colors mode.
    expect(cssRule(html, "details.card > summary:hover")).toContain("background: var(--bg-2)");
    expect(cssRule(html, ":focus-visible")).toContain("outline: 3px solid var(--accent-ring)");
  });

  test("html: badge and error colors come from theme token pairs, legacy hexes gone", () => {
    const html = renderHtml(report);
    // The tinted-pair badge idiom dissolves the old solid-fill contrast hacks:
    // no #8a6d00 dark ochre, no light-dark() error red, no white-on-solid pill.
    expect(html).not.toContain("#8a6d00");
    expect(html).not.toContain("#b8860b");
    expect(html).not.toContain("#c0392b");
    const badge = cssRule(html, ".badge");
    expect(badge).toContain("font-family: var(--font-mono)");
    expect(badge).toContain("font-size: var(--text-2xs)");
    expect(badge).toContain("border-radius: var(--radius-sm)");
    expect(cssRule(html, ".badge .dot")).toContain("background: var(--dot)");
    // Errors use the danger-subtle ink — AA in both themes via the var pair.
    expect(cssRule(html, ".errors li")).toContain("color: var(--danger-subtle-fg)");
  });

  test("html: Futurist tokens ride :root with a dark-scheme override, fonts imported with fallback", () => {
    const html = renderHtml(report);
    // Light values on :root, dark under prefers-color-scheme (self-contained
    // adaptation of the system's [data-theme] switch).
    expect(html).toContain("--bg-0: #f9fafb;");
    expect(html).toContain("@media (prefers-color-scheme: dark)");
    expect(html).toContain("--bg-0: #0f1114;");
    expect(html).toContain("color-scheme: light dark");
    // Q1: Google Fonts @import with the system's own fallback stacks.
    expect(html).toContain("@import url('https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible+Next");
    expect(html).toContain('--font-sans: "Atkinson Hyperlegible Next"');
    expect(html).toContain('--font-mono: "IBM Plex Mono", ui-monospace');
    const body = cssRule(html, "body");
    expect(body).toContain("background: var(--bg-0)");
    expect(body).toContain("color: var(--fg-2)");
    expect(body).toContain("font-family: var(--font-sans)");
  });

  test("html: cards layout narrows dl labels to 6rem; dt is the mono eyebrow in both layouts", () => {
    const html = renderHtml(report);
    expect(cssRule(html, ".cards dl")).toContain("6rem minmax(0, 1fr)");
    const dt = cssRule(html, ".kicker, .foot-brand, .group, .exceptions h2, dt, .legend > summary, .rollup-strip .seg-label");
    expect(dt).toContain("font-family: var(--font-mono)");
    expect(dt).toContain("font-size: var(--text-2xs)");
    expect(dt).toContain("text-transform: uppercase");
    expect(dt).toContain("letter-spacing: var(--tracking-caps)");
    expect(renderHtml(report, { layout: "flat" })).not.toContain(".cards dl");
  });

  test("html: body max-width is the token content width", () => {
    const body = cssRule(renderHtml(report), "body");
    expect(body).toContain("max-width: var(--max-content)");
    expect(renderHtml(report)).toContain("--max-content: 1200px;");
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

  test("html: masthead is kicker → date headline → window → chips, closed by a hairline", () => {
    const html = renderHtml(report);
    const masthead = html.slice(html.indexOf('<header class="masthead">'), html.indexOf("</header>"));
    // The date is the news: the constant product name drops to the mono
    // kicker and the window-end date takes the h1 slot.
    // The "// " flourish is presentational (::before), out of the copy text.
    expect(masthead).toContain('<p class="kicker">Agent standup</p>');
    expect(cssRule(html, ".kicker::before")).toContain('content: "// "');
    expect(masthead).toContain("<h1>Jul 8, 2026</h1>");
    expect(masthead.indexOf('class="kicker"')).toBeLessThan(masthead.indexOf("<h1>"));
    expect(masthead.indexOf("<h1>")).toBeLessThan(masthead.indexOf('class="window"'));
    expect(masthead.indexOf('class="window"')).toBeLessThan(masthead.indexOf('class="rollup-strip"'));
    // Legend lives inside the masthead as a quiet affordance.
    expect(masthead).toContain('<details class="legend">');
    // Hairline rule separates the masthead from content; kicker shares the
    // mono-eyebrow idiom (covered by the shared rule test).
    expect(cssRule(html, ".masthead")).toContain("border-bottom: 1px solid var(--border-1)");
    // The document title keeps the product name.
    expect(html).toContain("<title>Agent Standup — 2026-07-08</title>");
  });

  test("html: footer band folds provenance and trivial profiles under a top hairline", () => {
    const html = renderHtml({ ...report, trivialProfiles: ["tmp (codex)"] });
    const foot = html.slice(html.indexOf('<footer class="foot">'), html.indexOf("</footer>"));
    // Trivial-profiles note lives inside the footer band, not floating above it.
    expect(foot).toContain('<p class="ignored">Ignored 1 trivial profile');
    // Meta row: mono wordmark, dotted leader, then counts + provenance.
    expect(foot).toContain('<span class="foot-brand">Agent standup</span>');
    expect(foot).toContain('<span class="foot-leader" aria-hidden="true"></span>');
    // Pin the content (count, provenance, schema), not fmtUtc's exact bytes —
    // the timestamp format itself is covered by the timestamps test above.
    expect(foot).toContain("2 agents");
    expect(foot).toContain("schema v1");
    expect(foot).toContain("Generated ");
    expect(cssRule(html, ".foot")).toContain("border-top: 1px solid var(--border-1)");
    expect(cssRule(html, ".foot-leader")).toContain("dotted");
    // Without trivial profiles the note is absent but the band remains.
    const bare = renderHtml(report);
    expect(bare).not.toContain('class="ignored"');
    expect(bare).toContain('<footer class="foot">');
  });

  test("html: standup blurb is an upright inset tint, no quote-bar", () => {
    const standup = cssRule(renderHtml(report), "details.card .standup");
    expect(standup).not.toContain("italic");
    expect(standup).not.toContain("border-left"); // stripe idiom retired with the ban
    expect(standup).toContain("background: var(--bg-2)");
    expect(standup).toContain("color: var(--fg-2)");
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
      // --fg-3, not --fg-4: filler is a readable sentence, so it stays at the
      // design system's readable-text floor (AA contrast), merely de-emphasized.
      expect(cssRule(html, ".filler")).toContain("color: var(--fg-3)");
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
    expect(rule).toContain("font-size: var(--text-xs)");
    expect(rule).toContain("color: var(--fg-3)"); // de-emphasized vs the red reason
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
    expect(cssRule(html, ".dir")).toContain("color: var(--fg-4)");
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
    expect(html.indexOf('class="rollup-strip"')).toBeLessThan(html.indexOf("Trends:"));
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

  test("html: status badge is a dot+word span classed by status, no inline style", () => {
    const html = renderHtml({ ...report, agents: [blocked] });
    expect(html).toContain('<span class="badge st-needs_human" title=');
    expect(html).toContain('<span class="dot" aria-hidden="true"></span>needs_human</span>');
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

// Task-thread rendering (asl-1wm): a section per surface when
// Report.threads is present, byte-identical output when absent.
describe("task-thread rendering", () => {
  const thread = {
    threadKey: "asl-1wm",
    source: "bead" as const,
    title: "asl-1wm",
    status: "blocked" as const,
    evidence: "proven" as const,
    firstActivityAt: "2026-07-07T09:00:00.000Z",
    lastActivityAt: "2026-07-07T12:30:00.000Z",
    sessions: [
      {
        sessionId: "bbbb0000-0000-4000-8000-00000000000b", profile: "two (claude-code)", platform: "claude-code" as const,
        startedAt: "2026-07-07T09:00:00.000Z", lastEventAt: "2026-07-07T09:30:00.000Z",
        files: 2, commits: 0, errors: 1,
      },
      {
        sessionId: "aaaa0000-0000-4000-8000-00000000000a", profile: "one (claude-code)", platform: "claude-code" as const,
        startedAt: "2026-07-07T12:00:00.000Z", lastEventAt: "2026-07-07T12:30:00.000Z",
        files: 3, commits: 1, errors: 0,
      },
    ],
  };
  const fileThread = {
    ...thread,
    threadKey: "files:/repo/src/a_b.ts",
    source: "files" as const,
    title: "a_b.ts, c.ts",
    status: "completed" as const,
  };
  const withThreads: Report = { ...report, threads: [thread, fileThread] };

  test("markdown: threads section sits between exceptions and agents, members in order with counts", () => {
    const md = renderMarkdown(withThreads);
    expect(md.indexOf("## Exceptions")).toBeLessThan(md.indexOf("## Task threads"));
    expect(md.indexOf("## Task threads")).toBeLessThan(md.indexOf("## Agents"));
    expect(md).toContain("### asl-1wm — blocked, 2 sessions");
    expect(md).toContain("- 2026-07-07T09:00:00.000Z — two (claude-code) (session bbbb0000): 2 files, 0 commits, 1 error");
    expect(md).toContain("- 2026-07-07T12:00:00.000Z — one (claude-code) (session aaaa0000): 3 files, 1 commit");
    // file-cluster thread is labeled and its title is markdown-escaped
    expect(md).toContain("### a\\_b.ts, c.ts (file cluster) — completed, 2 sessions");
    // zero-error members don't render an error count
    expect(md).not.toContain("3 files, 1 commit, 0 errors");
  });

  test("markdown: no threads, no section — output identical to before", () => {
    expect(renderMarkdown(report)).not.toContain("Task threads");
    expect(renderMarkdown(withThreads).replace(/\n## Task threads\n[\s\S]*?\n## Agents\n/, "\n## Agents\n"))
      .toBe(renderMarkdown(report));
  });

  test("html: threads section renders with severity-classed status badge and escaped content", () => {
    const html = renderHtml(withThreads);
    expect(html).toContain("<h2>Task threads</h2>");
    expect(html.indexOf("Exceptions")).toBeLessThan(html.indexOf("Task threads"));
    expect(html.indexOf("Task threads")).toBeLessThan(html.indexOf("All agents"));
    expect(html).toContain('class="thread sev-warning"'); // blocked → warning
    expect(html).toContain("two (claude-code) (session bbbb0000): 2 files, 0 commits, 1 error");
    expect(html).toContain('<span class="thread-source">(file cluster)</span>');
    expect(renderHtml(report)).not.toContain("Task threads");
  });

  test("html: thread titles are escaped", () => {
    const nasty = { ...thread, title: "<img src=x>" };
    const html = renderHtml({ ...report, threads: [nasty] });
    expect(html).toContain("&lt;img src=x&gt;");
    expect(html).not.toContain("<img src=x>");
  });

  test("json: threads serialize as-is and are absent when undefined", () => {
    const parsed = JSON.parse(renderJson(withThreads));
    expect(parsed.threads).toHaveLength(2);
    expect(parsed.threads[0].threadKey).toBe("asl-1wm");
    expect(parsed.threads[0].sessions[0].files).toBe(2);
    expect("threads" in JSON.parse(renderJson(report))).toBe(false);
  });
});
