# Agent Status Ledger — Standup Card View — Design

Date: 2026-07-10
Status: Approved (design); implementation not yet scheduled
Scope: presentation + one additive narrative field. No schema bump
(`schemaVersion` stays 1), no server, no JavaScript in the report, no new
dependencies. Interactive Q&A is explicitly out of scope for this release but
shapes one invariant (§4).

## Motivation

The report reads like a machine's dossier about each agent. The idea: each
agent gives its own standup update — a short first-person blurb on a compact
card — and the human clicks into a card only when they want the full detail
(the structured fields, commits, files, errors we render today). Later, the
user should be able to ask an agent follow-up questions; that Q&A mode is a
future bolt-on, not part of this change.

Decisions made during brainstorming:

- Q&A is a **nice-to-have later**, not the core. Design cards first, leave a
  clean seam (option b).
- The standup blurb is a **new sixth narrative field** generated in the same
  LLM call; the five structured fields are unchanged (option a).
- Cards become the **default HTML layout**, with a flag for the legacy flat
  layout (option c).
- **No visible Q&A seam** ships (no copy-context button); instead the JSON
  output is guaranteed to carry the complete per-agent context bundle
  (option b).

## 1. The `standup` narrative field

`Narrative` (src/types.ts) gains one field:

```ts
export interface Narrative {
  workedOn: string;
  completed: string;
  inProgress: string;
  blocked: string;
  recommendation: string;
  standup: string;   // NEW: 2–4 sentences, first person, agent voice
}
```

**LLM path** (src/narrative.ts): the existing prompt additionally asks for a
`standup` value — 2–4 sentences, first person singular, written as the agent
giving its update at standup. It must be grounded in the same fact sheet as
the other fields (no invention), mention a blocker if one exists, and stay
under ~400 characters. Generated in the **same API call** — no added cost or
latency beyond a few output tokens.

**Template fallback** (no API key / LLM failure): assemble first-person text
from the facts, e.g. "I worked on <workedOn>. I completed <completed>.
Nothing is blocking me." / "I'm blocked: <blocked>." Same
`narrativeSource: "template"` marking as today.

**Parse hardening**: if the LLM response lacks `standup` (older cached
prompts, model misbehavior), fall back to the template assembly for that
field only — never render an empty blurb.

**Outputs**: JSON picks the field up automatically (`narrative` is serialized
whole; additive, schema stays v1 — same precedent as `trivialProfiles`).
Markdown renders the blurb as an italic lead line in each agent section.
The blurb is LLM output and flows through the existing `redact()` path like
every other rendered string.

## 2. HTML: card grid by default

The "All agents" section becomes a responsive grid of compact cards
(CSS `grid-template-columns: repeat(auto-fill, minmax(20rem, 1fr))`).

**Card front** (collapsed): agent display name, status badge, evidence tag,
standup blurb. Nothing else.

**Card expanded** (click): the full detail rendered today — the five
structured narrative fields as a `<dl>`, attributed commits, unattributed
commits, files touched, errors.

**Mechanism**: each card is `<details class="card">` with the front inside
`<summary>`. Zero JavaScript; the report stays a fully static, self-contained
file. In-place expansion changing row height within the grid is accepted
behavior, not a defect.

Unchanged: the Exceptions section at top, rollup line, legend, trivial-profile
footnote, footer.

## 3. Layout flag

`asl report --layout cards|flat`, default `cards`.

- `cards`: the new grid (§2).
- `flat`: today's layout, preserved as a separate render function inside
  src/render/html.ts (a branch, not a fork of the file).

CLI (src/cli.ts) validates the value and exits 2 with usage on anything else.
Markdown and JSON outputs are identical under both layouts.

## 4. Q&A readiness invariant

Nothing visible ships for Q&A. The seam is a stated contract:

> Each agent object in the JSON output carries the complete context bundle a
> future Q&A mode needs: `facts` (titles, files, errors, commits, session
> count, first/last activity), the full `narrative` (now including
> `standup`), `commits` with attribution, and `status`/`severity`/
> `evidence`.

This is already true today; the spec makes it an invariant so later slimming
of the JSON doesn't silently break the future `asl serve` / ask-an-agent
feature. A future Q&A implementation consumes the JSON (or the in-memory
`Report`) and needs no new data collection.

## 5. Testing

- narrative: LLM response with `standup` parses into the field; response
  missing `standup` falls back to template assembly for that field;
  template narrative produces first-person text containing no literal
  placeholder tokens.
- render/html: cards layout is the default; each agent renders a
  `<details>` card whose summary contains name, badge, evidence, blurb;
  expanded body contains the dl/commits/files/errors; `--layout flat`
  output matches the legacy snapshot.
- render/markdown: blurb appears as lead line per agent.
- redaction: a standup blurb containing a redact-pattern match is redacted
  in all three outputs.
- cli: invalid `--layout` value exits 2.

## Files touched

`src/types.ts`, `src/narrative.ts`, `src/render/html.ts`,
`src/render/markdown.ts`, `src/cli.ts`, tests. No new dependencies.

## Rejected alternatives

- **Render-side blurb assembly** (no prompt change): free but stilted; the
  whole point is text that reads like a person at standup.
- **Replace the five fields with one paragraph**: loses the structured
  detail view and breaks JSON consumers.
- **Separate `--view cards` artifact**: two HTML files to keep in sync;
  cards-as-default with a flat escape hatch is strictly simpler.
- **Copy-context button as visible Q&A seam**: deferred; adds JS to an
  otherwise JS-free page for a workflow (paste into Claude) the user didn't
  rate as needed.
