# Agent Status Ledger

A daily standup for every AI agent you run.

Local-first activity ledger and daily reporting system for AI agents. Every meaningful agent workstream gets a durable identity, every claim gets an evidence level, and the operator gets one morning answer: what did my agents do yesterday, what finished, what failed, and what needs me?

The full product spec is in [PRD.md](PRD.md) (draft v2, 2026-06-27). Nothing is built yet; this repo exists to iterate on the spec and then hold the implementation.

## Current state

Working v0 CLI. Run the morning report:

    bun install
    bun run src/cli.ts report --open          # LLM narratives if ANTHROPIC_API_KEY is set
    bun run src/cli.ts report --no-llm        # fully local, template narratives

Writes `reports/YYYY-MM-DD.{md,json,html}`. Sources scanned: Claude Code
(`~/.claude/projects`) and Codex (`~/.codex/sessions`), plus git commit
correlation per workdir. Config: `~/.config/asl/config.toml` (all optional).

- [PRD.md](PRD.md) — product spec (amended by docs/adr/)
- [docs/superpowers/specs/2026-07-07-asl-v0-design.md](docs/superpowers/specs/2026-07-07-asl-v0-design.md) — v0 design

## Origin

Idea pitched as "WorkingOn for agents" (2026-06-27); PRD drafted the same day. Prior art noted in the PRD: DailyBot Agent Heartbeat, beads viewer, AI-digest, LangSmith-class observability tools.
