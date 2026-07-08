# ADR 0002: v0 is a stateless scan, no database

Date: 2026-07-07
Status: Accepted

## Context

PRD.md (§14) specifies an append-first SQLite ledger with reports derived
from stored events. That is more infrastructure than needed to prove the
report format, and the source logs themselves already persist on disk.

## Decision

v0 has no database. `asl report` parses the source logs fresh on each run
for the requested window (default 24h), normalizes them into in-memory
Profile/Run/Event objects, and emits the report. Connectors emit the PRD's
normalized Event shape so a SQLite ledger can be added later by inserting a
persistence stage between connectors and reporter, without rewriting either.

## Consequences

- Fastest path to a first useful report; nothing to migrate while the
  schema is still being discovered.
- Silent-run detection is limited to what a single scan can see; durable
  history, dedupe across runs, and search arrive only with the ledger.
- The four pipeline stages (connectors → resolver → correlator → reporter)
  must communicate only via the normalized objects, keeping the future
  ledger insertion mechanical.
