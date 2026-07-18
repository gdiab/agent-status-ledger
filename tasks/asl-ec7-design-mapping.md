# asl-ec7 — Futurist design mapping for ASL rendered surfaces (PROPOSAL)

Read-only analysis; no source, test, or golden changed. Standard: `/Users/gd/github/futurist-design-system`
(DESIGN.md, readme.md, tokens/, components/). Surfaces: `src/render/html.ts` (interactive report),
`src/render/digest.ts` (email), `src/render/markdown.ts` (unstylable), status semantics from `src/status.ts`.

All hex values below are sRGB conversions of the system's oklch tokens (computed for this proposal —
the design system publishes **oklch only**; see §6/Q7). Contrast ratios are WCAG 2.1 computed values.

---

## 1. The design system's relevant rules (with sources)

### Typography
| Rule | Value | Source |
|---|---|---|
| UI/body/display face | Atkinson Hyperlegible Next → Atkinson Hyperlegible → system-ui | `tokens/typography.css:6-7`, DESIGN.md §3 |
| Data/mono face | IBM Plex Mono → ui-monospace → SF Mono → Menlo | `tokens/typography.css:8` |
| Base UI text | `--text-base` 0.875rem (14px); 0.8125rem (13px) in tables/controls | `tokens/typography.css:14`, DESIGN.md §3 |
| Scale | 0.6875 → 3.875rem (`--text-2xs`…`--text-6xl`), rem-based | `tokens/typography.css:11-22` |
| Headline / Title | 600wt, 1.5rem/1.15 / 1.0625rem/1.3, tracking −0.011em | DESIGN.md frontmatter `typography.headline/title` |
| Label / eyebrow | mono, 500wt, 0.6875rem, +0.08em, UPPERCASE, `//`-prefixed as section kicker | DESIGN.md §3 "Label", `tokens/base.css` `.mono-eyebrow` |
| **Mono Numbers Rule** | every numeric value in mono with its unit; right-aligned in tables | DESIGN.md §3 Named Rules |
| **Sentence Case Rule** | sentence case everywhere; the tracked mono eyebrow is the only uppercase; no emoji | DESIGN.md §3, readme.md CONTENT FUNDAMENTALS |

### Color
| Rule | Value | Source |
|---|---|---|
| Neutral ladder | `--bg-0…3` (#f9fafb / #ffffff / #f4f6f8 / #edeff1 light), ink ramp `--fg-1…4` (#1b1e24 / #4e5157 / #6d7075 / #a1a3a7); `--fg-3` is the readable-text floor | `tokens/colors.css:8-26`, DESIGN.md §2 |
| Hairlines | `--border-1` #e2e4e7 default; `--border-2/3` stronger | `tokens/colors.css:17-19` |
| Accent | Signal Green `--accent` #33d58e (~#2CDE85), for primary action / selection / **live state** only; **One Signal Rule**: ≤10% of any screen; never body-copy color | `tokens/colors.css:30-36`, DESIGN.md §2 Named Rules |
| Semantic palette | `--success` #00805a (hue 168, deliberately cooler than accent), `--warning` #da950b (hue 75), `--danger` #d23934 (hue 27), `--info` #0079b5 (hue 240); each with `-subtle` / `-subtle-fg` tinted pair; **status only, never decoration** | `tokens/colors.css:39-57`, DESIGN.md §2 |
| Warning text | `--warning-fg` is dark ink (#2a2011), not white — white-on-amber fails AA | `tokens/colors.css:45` |
| Dark theme | full override set under `[data-theme="dark"]`; light default on `:root`; every pair AA-verified in both | `tokens/colors.css:83-139`, DESIGN.md §1 |
| **Token Contract Rule** | every color/size/radius consumed as `var(--…)`; hardcoded values are drift | DESIGN.md §2 Named Rules |

### Spacing / radius / elevation
| Rule | Value | Source |
|---|---|---|
| Grid | 4px base; `--space-1…32`; page gutter 24px; card pad `--card-pad` 20px | `tokens/spacing.css` |
| Layout constants | `--max-content` 1200px, `--max-prose` 680px | `tokens/spacing.css:32-33` |
| Radii | controls 5px (`--radius-md`), cards 8px (`--radius-lg`), badges 3px (`--radius-sm`), pills `--radius-full` | `tokens/radius.css`, DESIGN.md §5 |
| **Hairline-First Rule** | flat surfaces separated by 1px hairlines; shadows only for true overlays; no zebra fills | DESIGN.md §4 |

### Component idioms relevant to reports
| Idiom | Spec | Source |
|---|---|---|
| Badge | `-subtle` bg + `-subtle-fg` text, mono `--text-2xs` (11px), 500wt, +0.03em, 18px tall, `--radius-sm`, optional 5px `currentColor` dot | `components/data/Badge.jsx`, DESIGN.md §5 Status & Badges |
| Status in tables | "a small colored **dot plus a word**, not a filled pill" | DESIGN.md §5 Tables |
| Tables | 13px text, mono numerics right-aligned, uppercase mono column headers, hairline row separators, no zebra | DESIGN.md §5 Tables |
| Cards | `--bg-1` on `--bg-0`, 1px hairline, `--radius-lg`, 20px pad, no shadow at rest; "cards are earned — dense data prefers tables and hairline lists" | DESIGN.md §5 Cards |
| Dotted-leader status line | `label ······ value` mono — signature grammar | DESIGN.md §5, readme.md tone examples |
| **Side-stripe ban** | "Don't use side-stripe borders (`border-left` > 1px as a colored accent) on cards, callouts, or alerts — use full hairlines, background tints, or leading dots instead" | DESIGN.md §6 Don'ts |
| Live state | may pulse a Signal Green dot | DESIGN.md §5 Status & Badges |
| Icons/marks | no emoji; unicode `↑ ↓ · ×` allowed in mono contexts; status = dots not glyphs | readme.md ICONOGRAPHY |

---

## 2. Proposed mapping — interactive HTML report (`src/render/html.ts`)

Mechanism note: the report is a single self-contained file using `color-scheme: light dark`
(html.ts:256) with no theme toggle. The system's `[data-theme]` mechanism doesn't apply as-is;
proposal: define the Futurist tokens as CSS custom properties on `:root` and override under
`@media (prefers-color-scheme: dark)` — token *names and values* preserved, switching mechanism
adapted. `light-dark()` stays available as a shorthand where a var pair is overkill.

| Surface element | Current style (file:line) | Proposed | Source rule |
|---|---|---|---|
| Page frame | `max-width: 80rem`, system-ui, `line-height 1.5`, no canvas color (html.ts:256-257) | body on `--bg-0` #f9fafb (dark #0f1114), text `--fg-2`, `--font-sans` (Atkinson stack; see Q1 on font loading), base 0.875rem, `line-height 1.5`, max-width `--max-content` 1200px (75rem — close to today's 80rem), 24px gutter | base.css body, spacing.css |
| `<h1>` "Agent Standup — day" | 1.5rem (html.ts:258) | Headline role: 600wt 1.5rem/1.15, −0.011em, `--fg-1` — unchanged size, add weight/tracking | DESIGN.md typography.headline |
| `.window` meta lines | `opacity:.7; font-size:.85rem` (html.ts:259) | `--fg-3` #6d7075 at `--text-xs` 12px; the timestamp *numbers* in `--font-mono` (Mono Numbers Rule) | DESIGN.md §3 |
| Rollup line + chips | badge-colored filled chips (html.ts:188-194) | counts in mono; chips become Futurist badges: `-subtle` bg + `-subtle-fg` text + 5px dot, mono 11px, radius 3px (see §3 for per-status colors) | Badge.jsx, DESIGN.md §5 |
| `.exceptions` box | `border: 1px solid light-dark(#c0392b55,#e07b6c55); radius 8px` (html.ts:260) | `--danger-subtle` background tint (#ffeae6 / dark #57221e) + 1px `--border-1` hairline, `--radius-lg` 8px, `--card-pad`; heading gets a `// EXCEPTIONS` mono eyebrow option (Q4) | DESIGN.md §6 "background tints", §5 |
| `.card` (agent card) | `border:1px #8884; border-left:3px var(--sev); radius 8px` (html.ts:261) | **side stripe removed** (explicit Don't). Card: `--bg-1` surface + 1px `--border-1` hairline + `--radius-lg`, 20px pad; severity carried by the status badge/dot alone. If a stronger cue is wanted: whole-card `-subtle` background tint for urgent only | DESIGN.md §6 side-stripe ban, §5 Cards |
| `.badge` status pill | white text on solid `--sev`, `radius 999px` (html.ts:264) | Futurist badge: dot + word, `-subtle`/`-subtle-fg` pair, mono 11px 500wt, radius 3px, 18px tall — "not a filled pill" | Badge.jsx, DESIGN.md §5 Tables |
| `.evidence` label | `opacity:.6; .75rem` (html.ts:265) | mono label: `--font-mono` 11px `--fg-3`, keep dotted-underline help affordance | DESIGN.md §3 Label |
| `<dl>` narrative rows | grid `8rem/6rem` cols, `dt` 600wt `opacity:.75` (html.ts:267-268, 240-241) | keep grid; `dt` becomes the mono eyebrow: `--font-mono` 11px 500wt +0.08em uppercase `--fg-3` (cards layout already uppercases at html.ts:241 — converges) | base.css `.mono-eyebrow` |
| `.standup` blurb | `border-left: 2px solid #8884` quote bar (html.ts:247) | ≤1px allowed by the ban's letter, but cleaner: drop the bar, use `--fg-2` italic or `--bg-2` inset tint | DESIGN.md §6 |
| `.errors li` | `light-dark(#c0392b,#e07b6c)` text (html.ts:16, 270) | `--danger-subtle-fg` #b02b27 (6.52:1 on white) / dark `--danger-subtle-fg` #ff988c; error context block on `--bg-inverse`-style panel optional | colors.css:52,124 |
| `code`, shas, counts, timestamps | inherited font, `.85em` (html.ts:272) | `--font-mono` explicitly, 0.92em per base.css; file paths keep `.dir` dimming via `--fg-4` | base.css code rule |
| `.thread` block | same card + 3px left stripe (html.ts:275) | hairline card like agent cards; status dot+word badge in the `<h3>`; per-run lines with mono timestamps and right-aligned mono counts | DESIGN.md §5 Tables |
| `.group` headers ("Needs attention"/"FYI") | uppercase, `.85rem`, `opacity:.7` (html.ts:237) | mono eyebrow with `//` prefix: `// NEEDS ATTENTION` — the signature kicker | DESIGN.md §3 |
| `details/summary` disclosure | `▸/▾` pseudo-marker (html.ts:242-246) | keep (no Futurist disclosure primitive exists — gap, Q5); marker in `--fg-4`, hover steps summary to `--bg-2` per interaction states | readme.md interaction states |
| Awaiting-question line | quoted `“…”` (html.ts:138, 221) | dotted-leader grammar candidate: `waiting on ······ “question”` in mono; or simply `--fg-2` with the quote — Q4 | DESIGN.md §5 |
| Focus/hover | none defined | `:focus-visible` 3px `--accent-ring`; summary hover `--bg-2` step | base.css, DESIGN.md §5 |
| Signal Green usage | none today | only: `active` status dot (live state) and links if any — respects One Signal Rule | DESIGN.md §2 |

`src/render/markdown.ts` — unstylable; adopt only content rules: already emoji-free and
sentence-case; no changes proposed (its Legend/labels stay as-is so `fixtures/golden/report.md`
is untouched). Optional nit: none worth a golden re-pin.

---

## 3. Status → color semantic mapping (exhaustive over `src/status.ts:8-12`)

Current: 3 severity colors only (`SEVERITY_COLOR`, html.ts:13 — urgent #c0392b, warning #8a6d00,
info #2d7a46). Proposal: a per-**status** map (new `src/render/theme.ts`), so `active` can read as
live and `completed` as success instead of both being generic green. Severity still picks the
fallback for surfaces that only know severity.

| Status | Severity (`status.ts`) | Futurist role | Solid (light / dark) | Badge pair light (bg / fg, contrast) | Badge pair dark (bg / fg, contrast) |
|---|---|---|---|---|---|
| `failed` | urgent | **danger** | #d23934 / #e95048 | #ffeae6 / #b02b27 — 5.64:1 | #57221e / #ff988c — 6.12:1 |
| `silent` | urgent | **danger**, hollow dot variant to distinguish from `failed` (Q2) | #d23934 / #e95048 | same danger pair | same danger pair |
| `blocked` | warning | **warning** | #da950b / #ebaa2d | #ffefd1 / #934f00 — 5.51:1 | #4c3211 / #efba64 — 6.70:1 |
| `needs_human` | warning | **warning** (alt: **info** to split "needs a decision" from "stuck" — Q3) | #da950b / #ebaa2d | warning pair (info pair: #dcf4ff / #005e93 — 6.10:1) | warning pair (dark info: #10364e / #78c7fd — 6.86:1) |
| `active` | info | **accent** (Signal Green live state — dot only, never a filled badge) | #33d58e / #36de95 | dot #33d58e + word in `--fg-2` #4e5157 (7.96:1 on white) | dot #36de95 + `--fg-2` #bbbec3 (9.62:1) |
| `idle` | info | **neutral** | `--fg-3` #6d7075 / #8d9197 | `--bg-3` #edeff1 / `--fg-2` #4e5157 — 7.0:1 | dark `--bg-3` #272a30 (correction: originally #26292f, a rounding slip) / `--fg-2` #bbbec3 |
| `completed` | info | **success** | #00805a / #23b189 | #dbf8ec / #006646 — 6.24:1 | #083c2d / #6fd5b0 — 6.98:1 |

Contrast notes:
- Every `-subtle` pair clears AA (≥4.5:1) in **both** themes — computed above; this is the system's
  designed guarantee (DESIGN.md §1) and it survives the oklch→hex conversion.
- Solid-fill badges are what breaks: white on `--warning` #da950b is **2.53:1** — the reason ASL
  currently ships the non-standard dark ochre #8a6d00 (html.ts:11-12). Adopting the tinted-pair
  badge idiom dissolves that whole problem; #8a6d00 disappears.
- Solid severity colors as *non-text graphics* (3:1 threshold): light `--danger` #d23934 on dark
  `--bg-0` is 3.94:1 (passes 3:1, fails 4.5:1 as text) — one more reason severity color should stop
  carrying text and stripes in dark mode; use per-theme tokens via the var/`light-dark()` mechanism.
- `EXCEPTION_STATUSES` (status.ts:26) stays the severity partition; color is presentation-only.

`STATUS_RANK` (status.ts:19) ordering is untouched; worst-first sorting already matches the
danger→warning→neutral/success visual gradient.

---

## 4. What the digest CANNOT adopt (Gmail constraints) and closest approximations

Constraints are pinned by `tests/digest.test.ts` — "never emits <details>, CSS grid, or
light-dark()" (digest.test.ts:185-193) and its thread twin (digest.test.ts:358-366), plus the
byte-pinned `NO_THREADS_GOLDEN` (digest.test.ts:238-264, asserted :266-269).

| Futurist feature | Why the digest can't have it | Pinning test | Closest inline approximation |
|---|---|---|---|
| `<style>` block / any stylesheet | Gmail strips `<style>` in many contexts | digest.test.ts:192, 365 (`not.toContain("<style")`) | inline `style=""` on every element (already the digest's regime, digest.ts:94) |
| CSS custom properties / Token Contract | `var(--…)` is stripped with the stylesheet; inline `var()` unsupported in Gmail | same `<style>` pin | resolve tokens to **hex literals at render time** from the shared `theme.ts` map — the token contract holds in source, the email ships hex |
| `oklch()` colors | no email-client support | golden byte-pin | the sRGB hex conversions in §3 |
| `light-dark()` / dark theme | Gmail flattens; digest is single-theme | digest.test.ts:191, 364 | ship light-theme hexes only; keep colors mid-lightness so Gmail's auto-darkening doesn't invert them illegibly (the `-subtle-fg` inks all sit ~#005-#b0 range — safe) |
| CSS grid | flattened | digest.test.ts:189-190, 362-363 | `<table role="presentation">` (already, digest.ts:75, 99) |
| `<details>` disclosure | stripped to always-open or dropped | digest.test.ts:186-187 | lead-sentence-only rows (already, `leadSentence` digest.ts:11) |
| Web fonts (Atkinson / IBM Plex Mono) | `@font-face`/`@import` need a stylesheet; Gmail strips | `<style>` pin | inline `font-family` stacks: prepend `'Atkinson Hyperlegible Next',` to the body stack and use `ui-monospace, 'SF Mono', Menlo, monospace` for numeric spans — renders for users with the fonts installed, degrades to system |
| Hover/focus/motion states | no interactivity in email | — | none; static severity presentation only |
| Side-stripe replacement | current digest uses `border-top:3px solid <sev>` per row (digest.ts:56, 83) — the same idiom DESIGN.md §6 bans as an accent stripe | NO_THREADS_GOLDEN pins the exact bytes | leading **dot + word**: `<span style="color:#d23934;">●</span>` before the status word, row separation by 1px #e2e4e7 hairline (`border-1`), exceptions box gets `background:#ffeae6` (`danger-subtle`) instead of the #c0392b55 border (digest.ts:46) |
| 8-digit hex alpha (#8884, #c0392b55) | patchy email support (currently shipped anyway, digest.ts:56) | golden | replace with opaque token hexes: #e2e4e7 hairline, #ffeae6 tint — strictly more compatible than today |

Everything else the digest *can* adopt inline: fg/bg neutral hexes (#1a1a1a → `--fg-1` #1b1e24,
opacity-based muting → literal `--fg-3` #6d7075), 14px base / 12px meta sizes, 8px-grid paddings,
`border-radius:8px` (already), mono numeric spans, sentence-case copy (already), no emoji (already).

---

## 5. Goldens and pinned tests needing deliberate re-pinning

1. **`NO_THREADS_GOLDEN`** — digest.test.ts:238-264: any digest byte changes. Re-pin once, in the
   digest slice, with a before/after visual check in Gmail (light + forced dark).
2. **`tests/render.test.ts` severity-CSS pins** — :566-570 and :645-648 assert `.sev-*` hex values
   `#8a6d00/#2d7a46/#c0392b` and `light-dark(#c0392b, #e07b6c)`; these become assertions on the new
   theme map (and #8a6d00/#b8860b checks retire). ~237 `toContain` assertions in that file mostly
   pin structure/escaping, not style — expect a handful more to touch (badge markup shape, stripe
   selectors like `.card` border-left).
3. **`fixtures/golden/report.md` / `report.json`** (golden.test.ts:103-108) — **no re-pin needed**
   if markdown/json are left alone as proposed. Guard: don't rename statuses/labels.
4. **`tests/email.test.ts`** — pins MIME structure and subject lines only; unaffected unless digest
   body text changes (it shouldn't — styling only).
5. `SEVERITY_COLOR` is exported from html.ts:13 and imported by digest.ts:4 — moving it into
   `theme.ts` touches both surfaces' tests in one commit unless the export is kept as an alias
   during the html slice.

---

## 6. Open questions for George

- **Q1 — Fonts in the self-contained report.** Atkinson Hyperlegible Next + IBM Plex Mono need a
  Google Fonts `@import` (`tokens/fonts.css`), i.e. a network fetch. The HTML report is currently a
  fully offline, self-contained artifact (also emailed as an attachment). Options: (a) `@import`
  with system fallback — degrades offline; (b) system stacks only, mono-vs-sans structure preserved
  — loses the brand face; (c) subset+base64-embed WOFF2 (~100-300KB heavier file). My lean: (a) —
  the fallback stack is the system's own. Your call.
- **Q2 — `silent` vs `failed`.** Both are urgent/danger. Worth a visual distinction (hollow dot ○
  vs filled ●, both danger-colored), or is one red the right amount of alarm?
- **Q3 — `needs_human` hue.** Warning amber (current severity semantics) or info blue ("a human
  decision is queued" is informational, not degradation)? Amber keeps the severity partition
  visually clean; blue makes triage richer. I lean amber for v1 — no semantic drift.
- **Q4 — How much signature grammar?** `//`-prefixed eyebrows on section headers and dotted-leader
  `waiting on ······ "…"` lines are the system's voice, but DESIGN.md §6 says "deliberately, not on
  every section". Adopt both, one, or neither in the report?
- **Q5 — Card side-stripe removal.** The 3px severity stripe (cards, threads, digest row tops) is
  ASL's strongest at-a-glance cue and is explicitly banned by DESIGN.md §6. Proposed replacement is
  dot+word badges plus `-subtle` tints. Accept the ban, or grant ASL a documented deviation?
  (Straight conflict between standard and surface — taste required.)
- **Q6 — Urgent cards' extra weight.** With stripes gone, should urgent (`failed`/`silent`) cards
  get a full `danger-subtle` background tint, or is the open-by-default `<details>` + red badge
  enough? (System precedent: alerts use background tints.)
- **Q7 — Hex fallbacks upstream.** The design system publishes oklch only; the digest (and any
  email consumer) needs hex. Should the derived hex table in §3 land upstream in
  futurist-design-system (e.g. `tokens/colors.hex.json`) so ASL isn't the owner of a private
  conversion?
- **Q8 — Digest under Gmail dark mode.** Gmail recolors light emails unpredictably. Ship
  light-only (proposed) and accept Gmail's auto-darkening, or hedge with mid-tone colors chosen to
  survive inversion? Light-only is the standard answer; flagging because you read this on a phone.

## 7. Suggested implementation slicing

1. **Slice A — `src/render/theme.ts` (new): tokens + status map.** Futurist token constants (light
   + dark hex, resolved from oklch), per-status color roles per §3, `SEVERITY_COLOR` kept as a
   derived alias for compatibility. Pure addition; no rendered-output change; unit tests for
   exhaustiveness over `Status` (compile-time `Record<Status, …>` like status.ts). Own bead/branch.
2. **Slice B — HTML report restyle (`src/render/html.ts`).** Token CSS variables +
   `prefers-color-scheme` overrides, typography, badges (dot+word), card/thread hairline treatment,
   exceptions tint, mono numerics. Re-pin render.test.ts style assertions. Own bead/branch;
   depends on A. Verify in browser light+dark and print.
3. **Slice C — digest restyle (`src/render/digest.ts`).** Inline hex from theme.ts, dot+word rows,
   hairline separators, danger-subtle exceptions box. Deliberate `NO_THREADS_GOLDEN` re-pin in the
   same commit, with a rendered-in-Gmail screenshot in the PR. Own bead/branch; depends on A.
   Keep C separate from B so the byte-golden re-pin is reviewable in isolation.
4. **(Optional) Slice D — signature grammar** (eyebrows, dotted leaders, `// EXCEPTIONS`) — gated
   on Q4; last, smallest, easiest to drop.

Markdown/JSON renderers: explicitly out of scope (no styling surface; goldens stay green).

## 8. Decisions (George, 2026-07-17)

- **Q1 fonts:** `@import` with system fallback for now. Longer term the report is served by a small
  cron-ensured `Bun.serve()` dashboard (fonts local, history view) — exploration filed as asl-eia;
  history location/retention/lifecycle to be fleshed out there.
- **Q2 silent:** hollow dot ○ (absence of signal) in **caution amber**, not danger red — silent may
  or may not be an issue, so it reads as caution; `failed` stays filled danger ●. Note this is a
  display hue only: `STATUS_SEVERITY.silent` remains `urgent` and the exception partition is
  unchanged. §3's silent row supersedes accordingly (warning family, hollow). Companion feature
  filed as asl-kjo: silent rows should surface what the agent was working on right before it went
  dark, to drive triage.
- **Q3 needs_human:** warning amber (no semantic drift).
- **Q4 signature grammar:** implementer's judgment, guided by DESIGN.md's "deliberately, not on
  every section"; George reviews visually.
- **Q5 side stripes:** ban accepted — dot+word badges + `-subtle` tints replace all stripes.
- **Q6 urgent card weight:** full `danger-subtle` background tint (system precedent); dial back to
  badge-only if too loud on review.
- **Q7 hex fallbacks:** yes — derived hex table lands upstream in futurist-design-system
  (`tokens/colors.hex.json`) so the conversion has one owner.
- **Q8 digest dark mode:** ship light-only; accept Gmail auto-darkening.
