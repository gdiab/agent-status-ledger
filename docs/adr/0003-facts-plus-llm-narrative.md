# ADR 0003: Deterministic facts + LLM-generated narrative

Date: 2026-07-07
Status: Accepted

## Context

The standup sections ("what I worked on, what blocked me, what I recommend")
need readable prose. Purely templated output reads like a log digest;
letting an LLM read raw transcripts risks hallucinated status in the very
tool whose purpose is grounded evidence, and conflicts with the PRD's
privacy rule that raw transcripts never leave the machine (§13).

## Decision

Facts are extracted deterministically (files touched, commands run, errors,
commits, session titles, statuses, evidence levels). One Claude Haiku call
per active agent profile converts the structured fact sheet into narrative
sections. The LLM never sees raw transcripts, and it cannot alter status,
evidence level, or artifact links — those are computed before the call. A
redaction pass runs on facts before the call and on the final report.
`--no-llm` falls back to template-only rendering.

## Consequences

- Reports are readable while status/evidence stay trustworthy.
- Requires an Anthropic API key; structured fact summaries (not
  transcripts) are sent externally. `--no-llm` preserves a fully local mode.
- Tests mock the LLM step; golden fixtures assert the deterministic parts.
