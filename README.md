# Agent Status Ledger

A daily standup for every AI agent you run.

Local-first activity ledger and daily reporting system for AI agents. Every meaningful agent workstream gets a durable identity, every claim gets an evidence level, and the operator gets one morning answer: what did my agents do yesterday, what finished, what failed, and what needs me?

The full product spec is in [PRD.md](PRD.md) (draft v2, 2026-06-27). Nothing is built yet; this repo exists to iterate on the spec and then hold the implementation.

## Current state

- [PRD.md](PRD.md) — the working spec. Data model (profiles / runs / events), status + evidence rules, connector strategy, MVP scope and acceptance criteria, 4-week build plan.

## Origin

Idea pitched as "WorkingOn for agents" (2026-06-27); PRD drafted the same day. Prior art noted in the PRD: DailyBot Agent Heartbeat, beads viewer, AI-digest, LangSmith-class observability tools.
