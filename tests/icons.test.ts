import { describe, expect, test } from "bun:test";
import type { AgentReport, Platform, Report } from "../src/types";
import { PLATFORM_MARKS, platformIcon, platformLabel } from "../src/render/icons";
import { renderHtml } from "../src/render/html";
import { renderEmailDigest } from "../src/render/digest";
import { rollupCounts } from "../src/render/rollup";

// Literal mirror of the Platform union. The two compile-time checks below
// make this test file fail to BUILD (not just fail) when the union and the
// mirror drift in either direction — widening Platform (e.g. gemini via
// asl-alg) forces both this list and PLATFORM_MARKS to grow together.
const PLATFORMS = ["claude-code", "codex"] as const satisfies readonly Platform[];
type MissingFromMirror = Exclude<Platform, (typeof PLATFORMS)[number]>;
const _mirrorIsExhaustive: MissingFromMirror extends never ? true : never = true;
void _mirrorIsExhaustive;

// A distinctive slice of each vendored mark's path data: proof the real
// product mark (not the fallback) rendered for that platform.
const PATH_SLICES: Record<Platform, string> = {
  "claude-code": "m4.7144 15.9555", // Claude starburst, first command
  codex: "M22.2819 9.8211", // OpenAI blossom, first command
};

const LABELS: Record<Platform, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

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

const report: Report = {
  schemaVersion: 1,
  generatedAt: "2026-07-08T07:00:00.000Z",
  windowStart: "2026-07-07T07:00:00.000Z",
  windowEnd: "2026-07-08T07:00:00.000Z",
  exceptions: [],
  agents: [agent({})],
};

describe("platform icons", () => {
  test("PLATFORM_MARKS covers exactly the Platform union", () => {
    expect(Object.keys(PLATFORM_MARKS).sort()).toEqual([...PLATFORMS].sort());
  });

  test("every platform renders its real mark: decorative currentColor svg by default", () => {
    for (const p of PLATFORMS) {
      const svg = platformIcon(p);
      expect(svg).toStartWith("<svg");
      expect(svg).toContain('class="platform-icon"');
      expect(svg).toContain('viewBox="0 0 24 24"');
      expect(svg).toContain('fill="currentColor"');
      expect(svg).toContain(PATH_SLICES[p]);
      // Decorative: the adjacent "(platform)" text already names the
      // platform, so the default icon must be hidden from AT entirely.
      expect(svg).toContain('aria-hidden="true"');
      expect(svg).not.toContain("role=");
      expect(svg).not.toContain("aria-label");
      expect(svg).not.toContain("<title>");
      // Token Contract Rule: no hardcoded colors, monochrome only.
      expect(svg).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(svg).not.toMatch(/fill="(?!currentColor)/);
    }
  });

  test("labeled variant carries role/aria-label/title and no aria-hidden", () => {
    for (const p of PLATFORMS) {
      const svg = platformIcon(p, { labeled: true });
      expect(svg).toContain('role="img"');
      expect(svg).toContain(`aria-label="${LABELS[p]}"`);
      expect(svg).toContain(`<title>${LABELS[p]}</title>`);
      expect(svg).not.toContain("aria-hidden");
      expect(svg).toContain(PATH_SLICES[p]);
    }
  });

  test("unknown platform gets the neutral fallback mark, raw id label, escaped", () => {
    const svg = platformIcon("evil<x> & co", { labeled: true });
    // fallback ring, not any vendored brand path
    for (const p of PLATFORMS) expect(svg).not.toContain(PATH_SLICES[p]);
    expect(svg).toContain('aria-label="evil&lt;x&gt; &amp; co"');
    expect(svg).toContain("<title>evil&lt;x&gt; &amp; co</title>");
    expect(svg).not.toContain("<x>");
    expect(svg).toContain('fill="currentColor"');
    // pure path fallback — no <text> (font dependence) in any icon
    expect(svg).not.toContain("<text");
  });

  test("fallback ring cut-out is winding-independent: evenodd fill rule", () => {
    // Under the default nonzero rule the ring hole depends on the inner
    // circle's winding; evenodd pins the cut-out regardless of sweep flags.
    const svg = platformIcon("unknown-platform");
    expect(svg).toContain('fill-rule="evenodd"');
    // branded marks keep the default rule untouched
    for (const p of PLATFORMS) expect(platformIcon(p)).not.toContain("fill-rule");
  });

  test("platformLabel maps known platforms and passes unknown ids through", () => {
    expect(platformLabel("claude-code")).toBe("Claude Code");
    expect(platformLabel("codex")).toBe("Codex");
    expect(platformLabel("something-else")).toBe("something-else");
  });
});

describe("html surfaces carry the platform mark", () => {
  test("flat card header shows the icon before the name, name text unchanged", () => {
    for (const p of PLATFORMS) {
      const a = agent({ platform: p, displayName: `w (${p})` });
      const html = renderHtml({ ...report, agents: [a] }, { layout: "flat" });
      expect(html).toContain(PATH_SLICES[p]);
      // icon precedes the heading; the (platform) text suffix is kept
      expect(html).toContain(`${platformIcon(p)}<h3>w (${p})</h3>`);
    }
  });

  test("standup card summary shows the icon before the name span, heading text unchanged", () => {
    const html = renderHtml(report);
    expect(html).toContain(`${platformIcon("claude-code")}<span class="name" role="heading" aria-level="3">w (claude-code)</span>`);
  });

  test("icons next to platform-suffixed names are decorative — no duplicated accessible name", () => {
    // The card heading / summary name already says "(claude-code)"; a labeled
    // icon there would make AT announce the platform twice. Guard both card
    // layouts: every icon adjacent to a name must be aria-hidden, and the
    // platform label must not appear as an aria-label anywhere in the card.
    for (const layout of ["cards", "flat"] as const) {
      const html = renderHtml(report, { layout });
      const cardStart = html.indexOf('class="card');
      const card = html.slice(cardStart, html.indexOf("</dl>", cardStart));
      expect(card).toContain('<svg class="platform-icon"');
      expect(card).toContain('aria-hidden="true"');
      expect(card).not.toContain(`aria-label="${LABELS["claude-code"]}"`);
      expect(card).not.toContain('role="img"');
      expect(card).not.toContain(`<title>${LABELS["claude-code"]}</title>`);
    }
  });

  test("unknown platform on a card renders the fallback mark, escaped", () => {
    const a = agent({ platform: "mystery<agent>" as Platform, displayName: "w (mystery<agent>)" });
    const html = renderHtml({ ...report, agents: [a] }, { layout: "flat" });
    for (const p of PLATFORMS) expect(html).not.toContain(PATH_SLICES[p]);
    expect(html).toContain('fill-rule="evenodd"');
    expect(html).not.toContain("<agent>");
  });

  test("thread run lines show the icon of the member session's platform", () => {
    const thread = {
      threadKey: "asl-x",
      source: "bead" as const,
      title: "asl-x",
      status: "completed" as const,
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
          sessionId: "aaaa0000-0000-4000-8000-00000000000a", profile: "one (codex)", platform: "codex" as const,
          startedAt: "2026-07-07T12:00:00.000Z", lastEventAt: "2026-07-07T12:30:00.000Z",
          files: 3, commits: 1, errors: 0,
        },
      ],
    };
    const html = renderHtml({ ...report, threads: [thread] });
    expect(html).toContain(`${platformIcon("claude-code")}two (claude-code) (session bbbb0000)`);
    expect(html).toContain(`${platformIcon("codex")}one (codex) (session aaaa0000)`);
    // decorative next to the "(platform)" profile text — no duplicated name
    const runs = html.slice(html.indexOf("<h2>Task threads</h2>"), html.indexOf("All agents"));
    expect(runs).not.toContain('role="img"');
    expect(runs).not.toContain(`aria-label="${LABELS["claude-code"]}"`);
  });

  test("triage/exceptions lines stay text-only", () => {
    const blocked = agent({ status: "needs_human", severity: "warning" });
    const html = renderHtml({ ...report, agents: [blocked], exceptions: [blocked] });
    const exceptionsBlock = html.slice(html.indexOf("<h2>Exceptions</h2>"), html.indexOf("</section>", html.indexOf("<h2>Exceptions</h2>")));
    expect(exceptionsBlock).not.toContain("<svg");
  });
});

describe("rollup per-platform counts", () => {
  const rollupOf = (html: string) => {
    const start = html.indexOf('<p class="rollup">');
    return html.slice(start, html.indexOf("</p>", start));
  };

  test("mixed platforms render icon+count segments before the status chips", () => {
    const mixed: Report = {
      ...report,
      agents: [
        agent({}),
        agent({ profileId: "claude-code:/x", displayName: "x (claude-code)", workdir: "/x" }),
        agent({ profileId: "codex:/y", displayName: "y (codex)", platform: "codex", workdir: "/y" }),
      ],
    };
    const rollup = rollupOf(renderHtml(mixed));
    expect(rollup).toContain('<span class="platforms">');
    // Labeled icons here: the mark alone carries the platform name, so it
    // keeps role="img"/aria-label/title (unlike the decorative card icons).
    expect(rollup).toContain(`${platformIcon("claude-code", { labeled: true })} 2`);
    expect(rollup).toContain(`${platformIcon("codex", { labeled: true })} 1`);
    // larger count first, and the segment precedes the status chips
    expect(rollup.indexOf(PATH_SLICES["claude-code"])).toBeLessThan(rollup.indexOf(PATH_SLICES.codex));
    expect(rollup.indexOf('class="platforms"')).toBeLessThan(rollup.indexOf('class="badge'));
    // status chip row itself stays status-only
    const chips = rollup.slice(rollup.indexOf('class="badge'));
    expect(chips).not.toContain("<svg");
  });

  test("equal counts order by platform id for determinism", () => {
    const mixed: Report = {
      ...report,
      agents: [
        agent({ profileId: "codex:/y", displayName: "y (codex)", platform: "codex", workdir: "/y" }),
        agent({}),
      ],
    };
    const rollup = rollupOf(renderHtml(mixed));
    expect(rollup.indexOf(PATH_SLICES["claude-code"])).toBeLessThan(rollup.indexOf(PATH_SLICES.codex));
  });

  test("single platform still shows its segment", () => {
    const rollup = rollupOf(renderHtml(report));
    expect(rollup).toContain(`${platformIcon("claude-code", { labeled: true })} 1`);
  });

  test("rollupCounts.byPlatform: count-desc, platform-id tiebreak, counts only", () => {
    const mixed: Report = {
      ...report,
      agents: [
        agent({ profileId: "codex:/y", displayName: "y (codex)", platform: "codex", workdir: "/y" }),
        agent({}),
        agent({ profileId: "codex:/z", displayName: "z (codex)", platform: "codex", workdir: "/z" }),
      ],
    };
    expect(rollupCounts(mixed).byPlatform).toEqual([
      { platform: "codex", count: 2 },
      { platform: "claude-code", count: 1 },
    ]);
    // equal counts: platform id order (rollup.ts owns counts, not markup)
    expect(rollupCounts(report).byPlatform).toEqual([{ platform: "claude-code", count: 1 }]);
    expect(rollupCounts({ ...report, agents: [], exceptions: [] }).byPlatform).toEqual([]);
  });

  test("zero-agent report keeps the plain sentence, no platform markup", () => {
    const html = renderHtml({ ...report, agents: [], exceptions: [] });
    expect(html).toContain("No agent activity in this window.");
    expect(rollupOf(html)).not.toContain("platforms");
    expect(rollupOf(html)).not.toContain("<svg");
  });
});

describe("digest stays svg-free", () => {
  test("email digest contains no inline svg (Gmail strips it)", () => {
    const mixed: Report = {
      ...report,
      agents: [agent({}), agent({ profileId: "codex:/y", displayName: "y (codex)", platform: "codex", workdir: "/y" })],
    };
    expect(renderEmailDigest(mixed)).not.toContain("<svg");
  });
});
