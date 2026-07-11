# Standup Card View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each agent gives a first-person standup blurb on a compact card; clicking a card expands to the full detail; `--layout flat` preserves the legacy HTML layout.

**Architecture:** One additive field (`standup`) on `Narrative`, generated in the same LLM call with a template fallback. The HTML renderer gains a `cards` layout (default) built on `<details>`/`<summary>` — zero JavaScript — with the legacy layout kept behind `--layout flat`. Markdown gets the blurb as an italic lead line; JSON picks it up automatically.

**Tech Stack:** TypeScript on Bun. `bun test`. No new dependencies.

Spec: `docs/superpowers/specs/2026-07-10-standup-card-view-design.md`

## Global Constraints

- `schemaVersion` stays **1** (additive change only — same precedent as `trivialProfiles`).
- The HTML report contains **no JavaScript** and no external resources.
- No new dependencies.
- `--layout` accepts exactly `cards` (default) or `flat`; anything else exits 2 with usage.
- LLM `standup` instruction: 2–4 short sentences, first person singular, under ~400 characters, grounded in the fact sheet, mention a blocker if one exists.
- If the LLM response lacks a usable `standup` string, fall back to the template `standup` for that field only — the other five fields keep their existing strict validation (any missing → whole narrative falls back).
- All work on branch `v03-standup-cards`. Commit per task. Do NOT push or open a PR — the repo's review flow (Codex + thermo) happens after handoff.
- Golden fixtures (`fixtures/golden/report.{md,json}`) are regenerated with `UPDATE_GOLDEN=1 bun test tests/golden.test.ts` and the diff must be reviewed before committing.

---

### Task 0: Branch + docs

**Files:**
- Commit (already on disk, untracked): `docs/superpowers/specs/2026-07-10-standup-card-view-design.md`, `docs/superpowers/plans/2026-07-10-standup-card-view.md`

- [ ] **Step 1: Create branch**

```bash
git checkout -b v03-standup-cards
```

- [ ] **Step 2: Commit the spec and plan**

```bash
git add docs/superpowers/specs/2026-07-10-standup-card-view-design.md docs/superpowers/plans/2026-07-10-standup-card-view.md
git commit -m "docs: standup card view design spec + plan (asl-z3u)"
```

---

### Task 1: `standup` narrative field

**Files:**
- Modify: `src/types.ts` (Narrative interface, ~line 79)
- Modify: `src/narrative.ts` (templateNarrative, PROMPT_HEADER, generateNarrative)
- Test: `tests/narrative.test.ts`
- Regenerate: `fixtures/golden/report.json` (narrative objects gain the field)

**Interfaces:**
- Consumes: existing `FactSheet`, `Status` from `src/types.ts`.
- Produces: `Narrative.standup: string` — every `Narrative` value in the system now carries it. `templateNarrative()` and `generateNarrative()` both populate it. Later tasks render it.

- [ ] **Step 1: Write the failing tests**

In `tests/narrative.test.ts`, replace the `templateNarrative` describe block with:

```ts
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
```

In the `generateNarrative` describe block, update the canned fixture in the "uses LLM response when valid" test:

```ts
    const canned = { workedOn: "w", completed: "c", inProgress: "i", blocked: "b", recommendation: "r", standup: "I fixed the login redirect and committed it." };
```

(the rest of that test is unchanged — `toEqual(canned)` now covers the sixth field)

Add one new test to the same describe block:

```ts
  test("LLM response missing standup keeps llm source, template-fills standup only", async () => {
    const canned = { workedOn: "w", completed: "c", inProgress: "i", blocked: "b", recommendation: "r" };
    const fetchFn = (async () =>
      new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(canned) }] }), { status: 200 })) as unknown as typeof fetch;
    const r = await generateNarrative(facts, "completed", { model: "m", apiKey: "k", fetchFn });
    expect(r.source).toBe("llm");
    expect(r.narrative.workedOn).toBe("w");
    expect(r.narrative.standup).toMatch(/^I /);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/narrative.test.ts`
Expected: FAIL — "standup is first person" fails (`n.standup` is `undefined`), "uses LLM response when valid" fails (`toEqual` mismatch: narrative lacks `standup`), "missing standup" test fails.

- [ ] **Step 3: Implement**

`src/types.ts` — add the field to `Narrative`:

```ts
export interface Narrative {
  workedOn: string;
  completed: string;
  inProgress: string;
  blocked: string;
  recommendation: string;
  standup: string;          // 2–4 sentences, first person, the agent speaking at standup
}
```

`src/narrative.ts` — replace `templateNarrative` with:

```ts
export function templateNarrative(f: FactSheet, status: Status): Narrative {
  const sessions = `${f.sessionCount} session${f.sessionCount === 1 ? "" : "s"}`;
  const topics = f.titles.length ? f.titles.join("; ") : "untitled work";
  const standup =
    `I worked on ${topics} across ${sessions}.` +
    (f.commits.length ? ` I landed ${f.commits.length} commit${f.commits.length === 1 ? "" : "s"}.` : "") +
    (f.errors.length ? ` I hit ${f.errors.length} error${f.errors.length === 1 ? "" : "s"} along the way.` : "") +
    (status === "needs_human" ? " I'm waiting on you for an approval or decision."
      : status === "blocked" || status === "failed" ? " I'm stuck and need help."
      : status === "silent" ? " I've gone quiet — check on me."
      : " Nothing is blocking me.");
  return {
    workedOn: `${sessions}: ${topics}.`,
    completed: f.commits.length ? `Commits: ${f.commits.join("; ")}.` : "No durable artifacts detected.",
    inProgress: status === "active" || status === "idle" ? `Last activity ${f.lastActivity}.` : "Nothing in progress.",
    blocked: f.errors.length ? `Errors seen: ${f.errors.join("; ")}.` : "No blockers detected.",
    recommendation:
      status === "failed" || status === "blocked" ? "Investigate the errors above."
      : status === "needs_human" ? "An approval or decision is waiting on you."
      : status === "silent" ? "Check whether this agent is stuck."
      : f.commits.length ? "Review the commits." : "No action needed.",
    standup,
  };
}
```

Replace `PROMPT_HEADER` with:

```ts
const PROMPT_HEADER = `You write one agent's entry in a morning standup report about AI coding agents.
Use ONLY the facts in the JSON below. Do not invent work, files, or outcomes.
Reply with STRICT JSON, no markdown fences, exactly these string fields:
{"workedOn": "...", "completed": "...", "inProgress": "...", "blocked": "...", "recommendation": "...", "standup": "..."}
One or two short sentences per field, except "standup": 2-4 short sentences, first person singular,
written as the agent itself speaking at standup ("I ..."), under 400 characters, grounded in the same
facts, mentioning the blocker if one exists. If a field has no supporting facts, say so plainly.`;
```

In `generateNarrative`, the five-field validation loop stays exactly as is. Replace the success `return` with:

```ts
    return {
      narrative: {
        workedOn: parsed.workedOn,
        completed: parsed.completed,
        inProgress: parsed.inProgress,
        blocked: parsed.blocked,
        recommendation: parsed.recommendation,
        standup: typeof parsed.standup === "string" && parsed.standup.trim()
          ? parsed.standup
          : fallback.narrative.standup,
      },
      source: "llm",
    };
```

(`fallback` is already computed at the top of the function — reuse it.)

- [ ] **Step 4: Run tests**

Run: `bun test tests/narrative.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Regenerate golden JSON and review the diff**

Run: `UPDATE_GOLDEN=1 bun test tests/golden.test.ts`
Run: `git diff fixtures/golden/`
Expected: `report.json` gains a `"standup"` line inside every `narrative` object (template voice, first person). `report.md` unchanged (markdown doesn't render it yet). Anything else in the diff is a bug — stop and investigate.

- [ ] **Step 6: Full suite**

Run: `bun test`
Expected: all pass (129 existing + 3 new/changed).

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/narrative.ts tests/narrative.test.ts fixtures/golden/report.json
git commit -m "feat: first-person standup field on narratives (asl-z3u)"
```

---

### Task 2: Markdown lead line

**Files:**
- Modify: `src/render/markdown.ts` (`agentSection`, ~line 6)
- Test: `tests/render.test.ts`
- Regenerate: `fixtures/golden/report.md`

**Interfaces:**
- Consumes: `Narrative.standup` from Task 1.
- Produces: each markdown agent section opens with `_<standup>_` immediately after the `### <name>` heading.

- [ ] **Step 1: Write the failing test**

In `tests/render.test.ts`, first update the shared `agent()` fixture's narrative (line 17) so the `Narrative` literal is complete:

```ts
    narrative: { workedOn: "Fixed login.", completed: "Login fix committed.", inProgress: "Nothing.", blocked: "None.", recommendation: "Review the commit.", standup: "I fixed the login bug and committed the fix. Nothing is blocking me." },
```

Then add to the `renderers` describe block:

```ts
  test("markdown: standup blurb is an italic lead line right after the agent heading", () => {
    const md = renderMarkdown(report);
    expect(md).toContain("_I fixed the login bug and committed the fix. Nothing is blocking me._");
    const section = md.slice(md.indexOf("### w (claude-code)"));
    expect(section.indexOf("_I fixed the login bug")).toBeLessThan(section.indexOf("- Status:"));
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/render.test.ts`
Expected: FAIL — the new test can't find the blurb line. All other tests still pass.

- [ ] **Step 3: Implement**

In `src/render/markdown.ts`, `agentSection`, change the start of the `lines` array from:

```ts
  const lines = [
    `### ${a.displayName}`,
    "",
    `- Status: **${a.status}** (${a.severity})`,
```

to:

```ts
  const lines = [
    `### ${a.displayName}`,
    "",
    `_${a.narrative.standup}_`,
    "",
    `- Status: **${a.status}** (${a.severity})`,
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/render.test.ts`
Expected: PASS.

- [ ] **Step 5: Regenerate golden markdown and review the diff**

Run: `UPDATE_GOLDEN=1 bun test tests/golden.test.ts`
Run: `git diff fixtures/golden/`
Expected: `report.md` gains one italic first-person line per agent section, directly under each `###` heading. Nothing else changes.

- [ ] **Step 6: Full suite**

Run: `bun test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/render/markdown.ts tests/render.test.ts fixtures/golden/report.md
git commit -m "feat: standup blurb as markdown lead line (asl-z3u)"
```

---

### Task 3: HTML card grid (default) + flat layout

**Files:**
- Modify: `src/render/html.ts` (restructure into shared body + two card variants)
- Test: `tests/render.test.ts`

**Interfaces:**
- Consumes: `Narrative.standup` from Task 1.
- Produces: `renderHtml(report: Report, opts?: { layout?: "cards" | "flat" })` — default `cards`. Task 4's CLI passes `{ layout }`. Existing one-argument call sites keep working.

- [ ] **Step 1: Write the failing tests**

Add to `tests/render.test.ts`:

```ts
  test("html: default layout renders details/summary standup cards in a grid", () => {
    const html = renderHtml(report);
    expect(html).toContain('<div class="cards">');
    expect(html).toContain('<details class="card">');
    expect(html).not.toContain('<article class="card">');
    // summary (card front) carries the blurb; full detail is behind it
    const summary = html.slice(html.indexOf("<summary>"), html.indexOf("</summary>"));
    expect(summary).toContain("I fixed the login bug and committed the fix.");
    expect(summary).toContain("w (claude-code)");
    const card = html.slice(html.indexOf('<details class="card">'), html.indexOf("</details>"));
    expect(card).toContain("<dt>Worked on</dt>");
  });

  test("html: --layout flat renders the legacy article cards, no collapsible agents", () => {
    const html = renderHtml(report, { layout: "flat" });
    expect(html).toContain('<article class="card">');
    expect(html).not.toContain('<details class="card">');
    expect(html).toContain("<dt>Worked on</dt>");
    expect(html).toContain('<details class="legend">'); // legend stays collapsible
  });

  test("html: standup blurb is escaped", () => {
    const a = agent({ narrative: { ...agent({}).narrative, standup: "I <b>bolded</b> things." } });
    const html = renderHtml({ ...report, agents: [a] });
    expect(html).toContain("I &lt;b&gt;bolded&lt;/b&gt; things.");
    expect(html).not.toContain("<b>bolded</b>");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/render.test.ts`
Expected: FAIL — no `<div class="cards">`, no `<details class="card">`, and `renderHtml` doesn't accept a second argument yet (TS transpiles anyway; the assertions fail).

- [ ] **Step 3: Implement**

Replace `src/render/html.ts` in full with:

```ts
import type { AgentReport, Report } from "../types";
import { rollupLine } from "./rollup";
import { EVIDENCE_HELP, SEVERITY_HELP, STATUS_HELP } from "./legend";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const SEVERITY_COLOR: Record<string, string> = { urgent: "#c0392b", warning: "#b8860b", info: "#2d7a46" };

export type HtmlLayout = "cards" | "flat";

function badges(a: AgentReport): string {
  return `<span class="badge" style="background:${SEVERITY_COLOR[a.severity]}" title="${esc(STATUS_HELP[a.status])}">${esc(a.status)}</span>
    <span class="evidence" title="${esc(EVIDENCE_HELP[a.evidence])}">${esc(a.evidence.replace("_", " "))}</span>`;
}

// Everything below the card header: shared by both layouts.
function cardBody(a: AgentReport): string {
  const commits = a.commits.filter((c) => c.attributed)
    .map((c) => `<li><code>${esc(c.sha.slice(0, 7))}</code> ${esc(c.subject)}</li>`).join("");
  const unattributed = a.commits.filter((c) => !c.attributed)
    .map((c) => `<li><code>${esc(c.sha.slice(0, 7))}</code> ${esc(c.subject)}</li>`).join("");
  const files = a.facts.filesTouched.map((f) => `<li><code>${esc(f)}</code></li>`).join("");
  const errors = a.facts.errors.map((e) => `<li>${esc(e)}</li>`).join("");
  return `<dl>
    <dt>Worked on</dt><dd>${esc(a.narrative.workedOn)}</dd>
    <dt>Completed</dt><dd>${esc(a.narrative.completed)}</dd>
    <dt>In progress</dt><dd>${esc(a.narrative.inProgress)}</dd>
    <dt>Blocked</dt><dd>${esc(a.narrative.blocked)}</dd>
    <dt>Next</dt><dd>${esc(a.narrative.recommendation)}</dd>
  </dl>
  ${commits ? `<h4>Commits</h4><ul>${commits}</ul>` : ""}
  ${unattributed ? `<details><summary>Other repo commits (not attributed to this agent)</summary><ul>${unattributed}</ul></details>` : ""}
  ${files ? `<details><summary>Files touched (${a.facts.filesTouched.length})</summary><ul>${files}</ul></details>` : ""}
  ${errors ? `<h4>Errors</h4><ul class="errors">${errors}</ul>` : ""}`;
}

function flatCard(a: AgentReport): string {
  return `<article class="card">
  <header>
    <h3>${esc(a.displayName)}</h3>
    ${badges(a)}
  </header>
  ${cardBody(a)}
</article>`;
}

function standupCard(a: AgentReport): string {
  return `<details class="card">
  <summary>
    <h3>${esc(a.displayName)} ${badges(a)}</h3>
    <span class="standup">${esc(a.narrative.standup)}</span>
  </summary>
  <div class="detail">
  ${cardBody(a)}
  </div>
</details>`;
}

export function renderHtml(report: Report, opts: { layout?: HtmlLayout } = {}): string {
  const layout = opts.layout ?? "cards";
  const day = report.windowEnd.slice(0, 10);
  const exceptions = report.exceptions.length
    ? report.exceptions.map((a) =>
        `<li><strong>${esc(a.displayName)}</strong> — ${esc(a.status)}: ${esc(a.narrative.recommendation)}</li>`).join("")
    : "<li>No exceptions — nothing needs you.</li>";
  const agentsSection = layout === "cards"
    ? `<section><h2>All agents</h2><div class="cards">${report.agents.map(standupCard).join("\n")}</div></section>`
    : `<section><h2>All agents</h2>${report.agents.map(flatCard).join("\n")}</section>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Standup — ${esc(day)}</title>
<style>
:root { color-scheme: light dark; font-family: -apple-system, system-ui, sans-serif; }
body { max-width: 60rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
h1 { font-size: 1.5rem; } h3 { margin: 0; font-size: 1.1rem; }
.window { opacity: .7; font-size: .85rem; }
.exceptions { border: 1px solid #c0392b55; border-radius: 8px; padding: 1rem 1.5rem; margin: 1rem 0; }
.card { border: 1px solid #8884; border-radius: 8px; padding: 1rem 1.25rem; margin: 1rem 0; }
.card header { display: flex; gap: .6rem; align-items: center; margin-bottom: .5rem; }
.badge { color: #fff; border-radius: 999px; padding: .1rem .6rem; font-size: .75rem; }
.evidence { opacity: .6; font-size: .75rem; }
dl { display: grid; grid-template-columns: 8rem 1fr; gap: .25rem .75rem; margin: .5rem 0; }
dt { font-weight: 600; opacity: .75; } dd { margin: 0; }
.errors li { color: #c0392b; }
code { font-size: .85em; }
.legend { opacity: .8; font-size: .85rem; margin: 1.5rem 0; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(20rem, 1fr)); gap: 1rem; align-items: start; }
.cards .card { margin: 0; }
details.card > summary { cursor: pointer; list-style: none; }
details.card > summary::-webkit-details-marker { display: none; }
details.card .standup { display: block; font-style: italic; margin-top: .5rem; }
details.card .detail { margin-top: .75rem; border-top: 1px solid #8884; padding-top: .5rem; }
</style>
</head>
<body>
<h1>Agent Standup — ${esc(day)}</h1>
<p class="window">${esc(report.windowStart)} → ${esc(report.windowEnd)}</p>
<p class="rollup">${esc(rollupLine(report))}</p>
<section class="exceptions"><h2>Exceptions</h2><ul>${exceptions}</ul></section>
${agentsSection}
<details class="legend"><summary>Legend</summary>
<h4>Statuses</h4><ul>${(Object.entries(STATUS_HELP)).map(([k, v]) => `<li><strong>${esc(k)}</strong> — ${esc(v)}</li>`).join("")}</ul>
<h4>Severity</h4><ul>${(Object.entries(SEVERITY_HELP)).map(([k, v]) => `<li><strong>${esc(k)}</strong> — ${esc(v)}</li>`).join("")}</ul>
<h4>Evidence</h4><ul>${(Object.entries(EVIDENCE_HELP)).map(([k, v]) => `<li><strong>${esc(k.replace("_", " "))}</strong> — ${esc(v)}</li>`).join("")}</ul>
</details>
${report.trivialProfiles?.length ? `<p class="window">Ignored ${report.trivialProfiles.length} trivial profile${report.trivialProfiles.length === 1 ? "" : "s"} (minimal activity, nothing produced): ${esc(report.trivialProfiles.join(", "))}</p>` : ""}
<footer class="window">Generated ${esc(report.generatedAt)} · schema v${report.schemaVersion}</footer>
</body>
</html>
`;
}
```

Notes for the implementer:
- `standupCard` puts the blurb in a `<span class="standup">` (not `<p>`) because `<summary>` permits phrasing + heading content; CSS makes it display block.
- The unattributed-commits/files `<details>` inside `cardBody` are nested inside the card's own `<details>` in cards layout — that nests fine and needs no changes.
- The first-details test slices from `<details class="card">`, which appears only in the agents section — the legend `<details class="legend">` comes later in the document, so the slice is safe.

- [ ] **Step 4: Run tests**

Run: `bun test tests/render.test.ts`
Expected: PASS — including the pre-existing html tests ("unattributed commits shown", "tooltip titles", "self-contained/escapes"), which all render with the default cards layout now.

- [ ] **Step 5: Full suite**

Run: `bun test`
Expected: all pass. (Golden test unaffected — it compares markdown and JSON only.)

- [ ] **Step 6: Commit**

```bash
git add src/render/html.ts tests/render.test.ts
git commit -m "feat: standup card grid as default HTML layout, flat kept as variant (asl-z3u)"
```

---

### Task 4: CLI `--layout` flag + redaction composition test

**Files:**
- Modify: `src/cli.ts`
- Create: `tests/cli.test.ts`
- Test (add one case): `tests/render.test.ts`

**Interfaces:**
- Consumes: `renderHtml(report, { layout })` from Task 3; `redact` from `src/redact.ts`.
- Produces: `asl report --layout cards|flat` (default `cards`); invalid values exit 2 with usage before any scanning.

- [ ] **Step 1: Write the failing tests**

Create `tests/cli.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

// The CLI validates --layout immediately after parseArgs, before loadConfig or
// any log scanning, so this subprocess test is fast and touches nothing real.
describe("cli", () => {
  test("invalid --layout exits 2 with usage", () => {
    const proc = Bun.spawnSync(["bun", "src/cli.ts", "report", "--layout", "bogus"]);
    expect(proc.exitCode).toBe(2);
    const err = proc.stderr.toString();
    expect(err).toContain('--layout must be "cards" or "flat"');
    expect(err).toContain("usage:");
  });
});
```

Add to `tests/render.test.ts` (spec §5: the blurb is LLM output and must flow through redaction; needs `import { redact } from "../src/redact";` at the top):

```ts
  test("html: standup blurb flows through redaction like all rendered output", () => {
    const a = agent({ narrative: { ...agent({}).narrative, standup: "I set api_key=hunter2secret and moved on." } });
    const html = redact(renderHtml({ ...report, agents: [a] }));
    expect(html).toContain("[REDACTED]");
    expect(html).not.toContain("hunter2secret");
  });
```

- [ ] **Step 2: Run tests to verify the cli test fails**

Run: `bun test tests/cli.test.ts tests/render.test.ts`
Expected: cli test FAILS (unknown option `--layout` makes `parseArgs` throw → the process exits 1, not 2). The redaction test should already PASS (redact runs on the full rendered string) — it's a regression guard, not new behavior.

- [ ] **Step 3: Implement**

In `src/cli.ts`:

Change the usage line:

```ts
const USAGE = "usage: asl report [--since 24h] [--open] [--no-llm] [--out DIR] [--layout cards|flat]";
```

Add to the `options` object in `parseArgs`:

```ts
      layout: { type: "string", default: "cards" },
```

Immediately after the `positionals[0] !== "report"` check (before `loadConfig()`), add:

```ts
  const layout = values.layout!;
  if (layout !== "cards" && layout !== "flat") {
    console.error(`error: --layout must be "cards" or "flat", got "${layout}"`);
    console.error(USAGE);
    process.exit(2);
  }
```

Change the html render line to pass it through:

```ts
  const html = redact(renderHtml(report, { layout }), config.redactPatterns);
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/cli.test.ts tests/render.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite**

Run: `bun test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts tests/cli.test.ts tests/render.test.ts
git commit -m "feat: --layout cards|flat flag, standup redaction guard (asl-z3u)"
```

---

### Task 5: End-to-end verification

**Files:** none modified — verification only.

- [ ] **Step 1: Full suite**

Run: `bun test`
Expected: all pass; note the count in the handoff.

- [ ] **Step 2: Live run, both layouts**

```bash
SCRATCH="${SCRATCH:-$(mktemp -d)}"
bun run src/cli.ts report --since 24h --out "$SCRATCH/asl-v03-check"
bun run src/cli.ts report --since 24h --no-llm --layout flat --out "$SCRATCH/asl-v03-check-flat"
```

Expected: first run logs `using API key from keychain anthropic-api-key (account: asl)` and writes md/json/html; second writes the flat variant without touching the API.

- [ ] **Step 3: Inspect the artifacts**

- Cards html: contains `<details class="card">`, one per agent; each summary holds a first-person blurb; the file contains no `<script>` tag. Optionally `open "$SCRATCH/asl-v03-check/<date>.html"` to eyeball expand/collapse and grid wrapping.
- Flat html: visually matches the pre-change report.
- JSON: every agent's `narrative.standup` is a non-empty first-person string (the Q&A context-bundle invariant: `facts`, full `narrative`, `commits`, `status`/`severity`/`evidence` all present).
- Markdown: italic blurb under each agent heading.
- LLM blurbs read like a person at standup, are grounded (spot-check one agent's blurb against its facts), and blockers are mentioned where status warrants.

- [ ] **Step 4: Verify the spec's test list is covered**

Spec §5 ↔ tests: standup parse (`narrative.test.ts`), missing-standup fallback (`narrative.test.ts`), template first-person (`narrative.test.ts`), cards default + summary content (`render.test.ts`), flat variant (`render.test.ts`), markdown lead line (`render.test.ts`), redaction (`render.test.ts`), invalid `--layout` exit 2 (`cli.test.ts`).

- [ ] **Step 5: Close the issue and hand off**

```bash
bd close asl-z3u --reason="implemented on v03-standup-cards"
git status
git log --oneline main..HEAD
```

Report to the user: test count, live-run observations, branch name, and the proposed next commands (push + PR + Codex/thermo review per repo convention). Do NOT push.
