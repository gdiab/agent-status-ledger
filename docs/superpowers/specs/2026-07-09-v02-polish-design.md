# Agent Status Ledger v0.2 — Polish — Design

Date: 2026-07-09
Status: Approved
Scope: feedback-driven polish only. No schema bump (`schemaVersion` stays 1),
no new subsystems. Four changes: noise filter, silent-status retune, error
context, status tooltips/legend.

## Motivation (user feedback on the v0.1 MVP)

1. A 12-second throwaway session run from `/` produced a full agent card
   whose every narrative field read "no supporting facts", and it was flagged
   as an urgent exception.
2. 6 of 13 agents reported **silent (urgent)**; most were interactive
   sessions the user simply stopped using — normal, not urgent. The status
   model assumed autonomous agents; actual usage is mostly interactive.
3. Error lines carry no context about what the agent was doing when the
   error occurred.
4. Status names (`silent`, `evidence: claimed_only`, …) are not
   self-explanatory in the report.

Chosen approach: **minimal-schema polish** — error context is composed into
the existing `errors: string[]` strings at ingest, the abandoned-session
heuristic is one new boolean on sessions, tooltips are HTML `title`
attributes. The rejected alternative (structured errors, new `abandoned`
status enum value, schema v2) buys nothing visible this release.

## 1. Noise filter — trivial profiles

A profile is **trivial** when ALL of:

- every session's duration (`lastEventAt - startedAt`) is under
  `thresholds.minSessionSeconds` (new config key, default **60**), and
- no files touched in any session, and
- no attributed commits, and
- no errors captured.

Behavior:

- Trivial profiles get no agent card and can never appear in Exceptions.
- They are not silently dropped: the report ends with one footer line, e.g.
  `Ignored 1 trivial profile (< 1 min of activity): / (claude-code)`.
  `Report` gains one optional field `trivialProfiles?: string[]` (display
  names). Additive and optional, so `schemaVersion` stays 1 and existing
  consumers are unaffected; md/html render the footer from it, json carries
  it as-is.
- Rollup counts exclude trivial profiles.

## 2. Silent retune — who had the ball?

New boolean on the normalized session: `awaitingUser` — true when the
session's final event indicates the ball is in the human's court, i.e. the
last event is the agent completing its reply (assistant turn with no
pending tool call). An unanswered trailing user message is NOT
awaitingUser — the agent owed a response, so long quiet there is suspect.

Precise rule per connector:

- **claude-code**: `awaitingUser` = last meaningful entry is an `assistant`
  message whose content contains no `tool_use` block awaiting a result
  (i.e. no dangling tool call at end of log). A trailing `user` entry that
  is a tool_result belongs to the agent's turn → not awaitingUser if the
  next agent action never came.
- **codex**: `awaitingUser` = last event is a task completion/agent message
  (e.g. `task_complete`, final `agent_message`) rather than a started-but-
  unfinished task or pending tool call.

Status inference change (`inferStatus`): the newest-open-session branch
that today yields `silent` after `silentThresholdHours` yields:

- `silent` (urgent) only when `awaitingUser === false` — the agent was
  visibly mid-work when it went quiet;
- `idle` (info) when `awaitingUser === true` — an interactive session the
  human walked away from. It stays `idle` indefinitely (diary entry, never
  an exception).

`active` (recent activity) is unchanged. Sessions with terminal events
(completed/failed/blocked/needs_human) are unchanged.

Edge: if a connector cannot determine the final event shape (unknown line
types, truncated log), default `awaitingUser = false` — fail toward
alerting, not toward suppressing.

## 3. Error context — "while doing X"

When a connector captures an error it also captures what was in flight and
composes a single string:

```
<error message> — while <toolName>: <first ~80 chars of tool input>
```

- **claude-code**: the error's surrounding entry identifies the tool_use
  (name + input) whose result errored; use that.
- **codex**: use the command/tool payload associated with the failed event
  when present.
- If no in-flight context is available, the error string stays as today.
- Context is truncated (~80 chars, single line, whitespace-collapsed)
  before composition; redaction applies to the composed string exactly as
  it does now (`errors` remains `string[]`, FactSheet unchanged, LLM
  prompt unchanged).

## 4. Tooltips + legend

- **HTML**: every status badge gets `title="<plain-language definition>"`;
  evidence labels likewise ("proven — commits or artifacts back this up").
  A collapsed `<details>` legend at the bottom lists all statuses,
  severities, and evidence levels with one-line definitions.
- **Markdown**: legend section only (no hover in md).
- Definitions live in one exported map (`src/render/legend.ts`) so md and
  html cannot drift.

Definition texts (draft, final wording at implementation):

- `active` — activity within the active window; working now.
- `idle` — open session, quiet, ball in your court; no action needed.
- `silent` — left open mid-work and quiet past the silent threshold;
  check whether it is stuck.
- `completed` — finished, or produced durable artifacts (commits).
- `failed` / `blocked` / `needs_human` — as evented by the agent.
- Evidence: `proven` (commits/artifacts), `partially_proven` (files
  touched, nothing durable), `claimed_only` (log claims only).

## Out of scope (explicitly deferred)

Trends across days, other delivery channels, `asl doctor`/setup skill,
structured error objects, schema v2, new status enum values.

## Testing

TDD throughout (red first). Deepest coverage on the `awaitingUser`
heuristic — it parses both JSONL dialects' end-of-log shapes:

- claude-code fixtures: ends with completed assistant reply → awaitingUser;
  ends with dangling tool_use → not; truncated/unknown tail → not.
- codex fixtures: ends with task_complete/agent_message → awaitingUser;
  ends with task_started and no completion → not.
- status tests: long-quiet open session flips silent↔idle on the flag.
- noise filter: trivial by all four criteria; each criterion alone defeats
  triviality; footer line lists ignored profiles; rollup excludes them.
- error context: composed string shape, truncation, redaction of secrets
  inside tool input, absent-context passthrough.
- renderers: tooltip `title` attributes present and escaped; legend in both
  formats from the shared map.
- goldens re-pinned via UPDATE_GOLDEN=1 with diffs inspected.

Acceptance check against the 2026-07-09 real report: the `/` profile drops
to the footer, silent exceptions collapse to sessions genuinely left
mid-work, errors read "— while …" where logs contain the context.
