# ADR 0001: MVP v0 connectors are Claude Code and Codex CLI

Date: 2026-07-07
Status: Accepted

## Context

PRD.md (§11) ordered MVP v0 connectors as OpenClaw/Ralph/Hermes first, with
Claude Code and Codex deferred to phase 1.5. A survey of this machine showed
the opposite activity profile: ~375 Claude Code session files and ~49 Codex
session files touched in the last 7 days, versus zero for OpenClaw and one
for Gemini CLI. Building the first connector against a dormant source would
leave the MVP unable to prove itself on real daily activity.

## Decision

MVP v0 ships two connectors: Claude Code (`~/.claude/projects/**/*.jsonl`)
and Codex CLI (`~/.codex/sessions/**/*.jsonl` + `session_index.jsonl`).
Git correlation stays in scope. OpenClaw, Gemini CLI, and export-based
web/app sources become later plugins behind the same connector interface.

## Consequences

- The first real report reflects actual daily work on this machine.
- PRD §11 build ordering is superseded; the PRD should be treated as
  amended by this ADR.
- The connector interface must stay plugin-shaped so the deferred sources
  can be added without core changes.
