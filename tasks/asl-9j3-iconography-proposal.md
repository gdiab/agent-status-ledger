# asl-9j3 — Platform iconography proposal (PROPOSAL — nothing implemented)

Goal: each card / thread run / rollup chip shows *which product* (Claude Code, Codex, …) produced it,
at a glance, using the actual product marks — not generic glyphs. Surfaces: `src/render/html.ts`
(+ `rollup.ts`, `theme.ts`), `src/render/digest.ts` (Gmail). Markdown/JSON renderers untouched, goldens untouched.

Current state: platform identity reaches the reader only as the text suffix inside
`displayName` (`"${basename(cwd)} (${platform})"`, types.ts:81). `AgentReport.platform`
(`"claude-code" | "codex"`, types.ts:7,39) is already on every report row, so rendering needs no data changes.

---

## 1. Asset sourcing & licensing

| Option | Verdict |
|---|---|
| Official brand-kit downloads (Anthropic / OpenAI / Google press pages) | Full-color marks, per-brand usage rules (clear space, color, no-modify). Heavier to vendor and monochrome treatment technically violates some color rules. |
| **Simple Icons vendored paths (recommended)** | Community-maintained single-path SVGs of the real marks: `claude` (Anthropic's Claude starburst), `openai` (OpenAI blossom — Codex has no distinct product mark), `googlegemini` (Gemini spark). Icon data is CC0; trademarks remain their owners'. We vendor 3 path strings (~1–2 KB total) into `src/render/icons.ts` — no dependency, no network. |
| Remote fetch (CDN) | Rejected — report must stay self-contained/offline. |

Trademark note (for George's sign-off): this is nominative use — the mark identifies the product that
produced the session, in a personal/internal report. Monochrome single-color treatment is the standard
low-risk rendering (it's what every "works with X" integrations page does). Risk assessed negligible;
if you'd rather be strict, the fallback-mark-only design (§4) works for all platforms.

## 2. HTML report treatment

- **Size/placement**: 14px inline `<svg viewBox="0 0 24 24">` preceding the name, `vertical-align:-0.125em`,
  in: flat-card `<h3>`, standup-card `<summary>` name span, thread run lines, and rollup — the rollup line
  gains per-platform agent counts (`icon 5 · icon 2`) next to the existing status chips, so the chip row
  itself stays status-only.
- **Color**: `fill="currentColor"` at the surrounding ink (`--fg-2` in headers). No brand colors:
  semantic palette is status-only and the One Signal Rule caps accent use — a colored logo would read
  as a status signal. `currentColor` also makes dark mode free (inherits the dark ink ramp; no
  white-on-dark variants to manage). Token Contract Rule satisfied — no hardcoded color.
- **Text suffix**: the icon *replaces* the `(claude-code)` suffix on HTML surfaces. html.ts strips the
  exact known suffix `" (" + a.platform + ")"` from `displayName` (deterministic — it's constructed in
  report.ts) and renders `icon + name`. The icon carries `role="img"` + `aria-label="Claude Code"` and a
  `<title>` tooltip, so accessibility and hover-discoverability are preserved. Triage/exceptions `<li>`
  lines keep plain text (they're sentences, not chips).
  - *Alternative considered*: keep the text suffix and prepend the icon (belt-and-braces, zero strip
    logic). Rejected as redundant clutter against the restrained standard, but trivially available if
    you prefer it.

## 3. Email digest (Gmail constraints)

| Technique | Gmail | Verdict |
|---|---|---|
| Inline `<svg>` | Stripped entirely | Dead on arrival |
| `data:` URI `<img>` (PNG) | Blocked in Gmail (works in Apple Mail only) | Unreliable for the primary client |
| Remote `<img>` | Blocked-by-default + violates self-contained rule | Rejected |
| Text label (today's behavior) | Works everywhere | **Recommended** |

**Decision: digest stays text-only** — `displayName` keeps its `(claude-code)` suffix there, unchanged.
This is the "documented decision" branch of the acceptance criteria. No digest golden re-pin.

## 4. Unknown-platform fallback

`platformIcon(platform: string)` returns the mapped mark or a neutral fallback: a 24-viewBox circle
outline with a centered dot (pure path, no `<text>` — avoids font dependence), same 14px/currentColor
treatment, `aria-label` = the raw platform id. Emoji-free, reads as "an agent, brand unknown."

Compile-time exhaustiveness: the mapping is `const PLATFORM_ICONS: Record<Platform, string>` — when the
`Platform` union widens (e.g. gemini via asl-alg), the build fails until an icon is added. The
string-typed lookup wrapper is what render call sites use, so a future config-driven platform still
degrades to the fallback instead of crashing. Gemini's `googlegemini` path gets vendored now (commented,
ready) since asl-alg is on the backlog.

## 5. Implementation shape & tests

- New `src/render/icons.ts`: vendored path constants, `PLATFORM_ICONS` record, `platformIcon()` +
  `platformLabel()` ("claude-code" → "Claude Code").
- `html.ts`: icon injection at the 4 sites above; suffix strip helper. `theme.ts` untouched (currentColor).
- Tests: exhaustive pin — for every member of `Platform`, rendered HTML contains that platform's
  `aria-label` and path data; fallback pinned for an unknown string; digest test pins *absence* of `<svg>`.
  HTML render pins updated; JSON/markdown goldens byte-identical (asserted).
- Usual gates: Codex (mcp read-only) + thermo review, fix agent, re-verdicts, then merge.

## Questions for George

1. Icon replaces the text suffix on HTML surfaces (recommended), or icon + keep suffix?
2. Monochrome `currentColor` marks (recommended), or brand-color marks despite the status-signal ambiguity?
3. OK to vendor Simple Icons paths for the real marks (nominative use), or prefer neutral fallback marks only?
4. Rollup: add the per-platform icon counts, or leave rollup text-only and icon just cards/threads?

## Decisions (George, 2026-07-18)

1. **Keep the text suffix** — icon + suffix for now; revisit removing the suffix once the
   iconography is proven to work well. (§2's strip logic is NOT implemented.)
2. **Monochrome `currentColor` marks** as recommended.
3. **Vendor the Simple Icons paths** for the real marks. Note: `openai` was removed from
   simple-icons after v15.0.0 (brand request); path vendored from the pinned 15.0.0 release.
   All three marks are 24×24 single-path.
4. **Add per-platform icon counts to the rollup** — "let's see what that looks like."
