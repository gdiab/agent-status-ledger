# ADR 0004: TypeScript on Bun

Date: 2026-07-07
Status: Accepted

## Context

The MVP is a local CLI that parses JSONL, runs git commands, calls one API,
and renders Markdown/JSON/HTML. Python, Go, and TypeScript were considered.

## Decision

TypeScript running on Bun. Bun executes TS directly with no build step,
has a built-in test runner, ships `bun:sqlite` for the future ledger
(ADR 0002), and matches the ecosystem the owner already works in daily.

## Consequences

- Fast iteration; `bun test` for the golden-fixture suite.
- Distribution beyond this machine (if it becomes a product) will need
  `bun build --compile` or a Node-compat pass — accepted as a later concern.
