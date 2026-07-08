# ADR 0005: Local delivery — Markdown, JSON, and a dated static HTML page

Date: 2026-07-07
Status: Accepted

## Context

PRD.md (§16) lists local Markdown + JSON plus a Telegram exceptions summary
for MVP delivery. An interactive standup-board web app was also considered.
Both add moving parts (bot setup, a server) before the report format itself
is proven.

## Decision

v0 writes three artifacts per run to the configured reports directory:
`YYYY-MM-DD.md`, `YYYY-MM-DD.json`, and a fully self-contained
`YYYY-MM-DD.html` standup page (inline CSS/JS, no server, no external
requests), opened automatically with `--open`. Telegram delivery and the
interactive board are deferred; the JSON report is the board's future data
source.

## Consequences

- Zero external services in v0; the morning ritual is `asl report --open`.
- The HTML page must render exceptions-first and stay readable as agent
  count grows, since it is the primary human surface.
- The JSON schema becomes a public contract for later delivery surfaces
  (board app, Telegram, cmux notify) and should be versioned from day one.
