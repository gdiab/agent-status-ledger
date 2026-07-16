# PRD: Agent Status Ledger

**Working title:** Agent Status Ledger  
**Tagline:** A daily standup for every AI agent you run  
**Owner:** George Diab  
**Draft date:** 2026-06-27  
**Status:** Draft v3, amended 2026-07-16 to reflect the 2026-07-15 Engram fidelity review

---

## 1. Executive Summary

AI work is spreading across too many surfaces to manage by memory.

A single operator may have Claude Code working in one repo, Codex CLI in another, ChatGPT doing product research, Claude.ai exploring strategy, OpenClaw or Hermes agents running background tasks, and GitHub workflows producing PRs, commits, and CI results. Each tool has its own history. Each one reports differently. Some do not report at all.

Agent Status Ledger is a local-first activity ledger and daily reporting system for AI agents. It treats every meaningful agent workstream like an employee. Each agent gives a 24-hour status update, then the operator receives a concise rollup digest.

The product answers one morning question:

> What did my agents do yesterday, what finished, what failed, and what needs me?

This is not a human standup product. It is an operational visibility layer for people who delegate work to AI agents across disconnected tools.

---

## 2. Problem

AI agents are useful enough to do real work, but not mature enough to manage themselves.

Today, an operator has to reconstruct AI activity by checking:

- Local terminal sessions
- Claude Code logs
- Codex CLI history
- ChatGPT or Claude web conversations
- OpenClaw/Hermes session records
- Git commits, PRs, issues, and CI results
- Slack, Telegram, email, or desktop completion pings
- Browser tabs that may or may not still be open

This creates a new operational tax.

### Core pain points

- **Lost work:** Agents complete useful tasks without the operator noticing.
- **Silent failures:** Agents stall, loop, hit auth issues, or stop producing events.
- **Fragmented evidence:** The useful proof lives across logs, commits, PRs, transcripts, screenshots, and chat messages.
- **Weak accountability:** Agents may claim success, but the operator still has to verify artifacts manually.
- **No durable memory:** A web chat or terminal session may contain important work, but it is not automatically folded into a project record.
- **Morning catch-up tax:** The operator spends time asking, “What happened while I was away?” instead of deciding what to do next.

---

## 3. Target User

### Primary user

A technical operator, founder, engineering leader, or power user who delegates work to multiple AI agents across local and cloud tools.

This user likely uses:

- Claude Code, Codex CLI, Gemini CLI, OpenCode, or similar terminal agents
- ChatGPT, Claude.ai, Codex web/cloud, or Claude app projects
- OpenClaw, Hermes, Ralph-style subagents, cron jobs, or workflow automations
- GitHub PRs, issues, commits, and CI as the durable artifact trail

### Secondary users

- Small technical teams running many coding agents
- AI-native consultancies or agencies coordinating agent work across client projects
- Engineering managers who want status visibility without asking humans to summarize agent activity manually

---

## 4. Product Principle

The product metaphor is simple:

> Every agent is an employee. Every morning, each employee gives a status update.

Agent Status Ledger should not flatten all AI activity into a generic usage summary. It should preserve the identity of each agent workstream.

Examples:

- “Claude Code, AnxiLog repo” gives its own report.
- “Codex CLI, blog repo” gives its own report.
- “Claude.ai, Agent Ledger research project” gives its own report.
- “OpenClaw Ralph, iOS QA task” gives its own report.
- “Codex web, PR implementation task” gives its own report.

Then the operator receives a rollup across all agent entities.

---

## 5. Goals and Non-Goals

### Goals

1. Generate a daily per-agent status report covering the previous 24 hours.
2. Aggregate agent activity from local CLI tools, local orchestration systems, GitHub artifacts, and importable web/app transcripts.
3. Preserve evidence for meaningful claims: commits, PRs, files, logs, CI runs, transcripts, messages, screenshots, or manual notes.
4. Surface exceptions first: blocked, failed, silent, or needs-human agents.
5. Deliver the report where the operator already pays attention.
6. Work even when some connectors provide partial evidence.

### Non-goals

- Replacing human standups
- Building a generic team check-in product
- Becoming a full LLM trace/eval observability platform
- Depending on fragile browser scraping for MVP
- Requiring every vendor to expose a perfect API before the product is useful

---

## 6. Market and Competitive Context

### Closest commercial match: DailyBot Agent Heartbeat

DailyBot’s Agent Heartbeat is the closest commercial signal found. It lets agents report status, flag issues, and appear in the same check-in flow as humans.

That validates demand for agent visibility, but the framing is different. DailyBot positions agents as an extension of human standups. Agent Status Ledger should be agent-only, local-first, cross-surface, and built around the operator who manages AI work across many tools.

### Dashboard-adjacent products

Relevant products and projects include:

- AgentCenter
- AgentsRoom
- Claude Code Agent View
- Claude Code Agent Monitor
- AgentGraphed
- AgentLogs

These products make agent activity visible, usually through dashboards or session viewers. They are useful but not the same as a daily, evidence-backed operating report.

### Observability-adjacent products

Relevant observability platforms include:

- LangSmith
- Langfuse
- Arize Phoenix / AX
- HoneyHive
- Braintrust
- Sentry AI agent observability

These tools are strong for traces, evals, monitoring, and production debugging. Agent Status Ledger can consume observability data later, but its product surface is different: a concise daily status ritual for agent work.

### Open-source signals

Relevant open-source or local projects include:

- **AI-digest**: parses local logs from Claude Code, Codex, Gemini CLI, OpenCode, and similar tools to generate daily reports.
- **AgentGraphed**: indexes Claude Code and Codex sessions locally.
- **Claude Code Agent Monitor**: tracks Claude Code sessions, agent activity, tool usage, and subagent orchestration.
- **AgentLogs**: provides visibility into coding-agent sessions and links conversations to code commits.

These projects suggest the local-first MVP is feasible.

---

## 7. Core Data Model

The PRD uses four distinct objects:

1. **Agent Profile**: the durable identity of an agent workstream.
2. **Agent Run**: a specific execution/session/task performed by that profile.
3. **Event**: a normalized activity record produced by a connector.
4. **TaskThread** (decided, not yet shipped — tracked as bead asl-1wm): the report's decided primary grouping — runs from any profile, across sessions and days, stitched into one task-level narrative.

This distinction matters. Without it, entity resolution becomes ambiguous.

### Agent identity anchoring (decided 2026-07-15, not yet shipped)

**Decided target model (2026-07-15 fidelity review):** agent identity anchors to **orchestrator runs**. The top-level session the operator started is the identity-bearing run; subagent runs do not get independent profiles. Instead they attach to their orchestrator as a **lineage tree**, discovered via dispatch markers: the dispatching session prepends `<engram-src id="<session-uuid>"/>` to every Agent-tool dispatch prompt, and the subagent's transcript carries that marker as a content prefix of its first inbound message. This gives deterministic parent→child linkage without timestamp/repo heuristics.

**Shipped behavior today:** profiles are still workdir-based (`platform:workdir`), subagent runs get their own profiles and their own report cards, and dispatch-marker lineage is used only to cross-reference profiles ("dispatched" / "dispatched by" links between cards) — it does not yet collapse subagent runs under their orchestrator. Migrating identity to the orchestrator-anchored model is decided but not implemented; the workdir-based acceptance criterion in §12 reflects shipped behavior until then.

Two consequences to state plainly:

- Lineage is convention-dependent. History only accrues from the point the dispatch-marker convention was adopted; earlier subagent runs remain unattributed and the report must not guess.
- Lineage discovery can be partial. When a lineage walk is truncated (candidate caps, missing tapes), the report must surface the dispatched list as incomplete rather than present an undercount as complete.

### Agent Profile

A stable identity across days.

Examples:

- `claude-code:anxilog-ios`
- `codex-cli:georgediab-blog`
- `openclaw:ralph-ios-qa`
- `chatgpt:web-product-research`
- `claude-ai:agent-status-prd-project`

Required fields:

- `agent_profile_id`
- `display_name`
- `source_platform`
- `source_type`: CLI, web, app, cloud, local orchestrator, automation
- `scope`: workdir, repo, project, chat, cron job, or task family
- `owner`
- `created_at`
- `last_seen_at`

Optional fields:

- `role_or_purpose`
- `default_delivery_group`
- `sensitivity_level`
- `tags`

### Agent Run

A specific session or task execution under an agent profile.

Required fields:

- `agent_run_id`
- `agent_profile_id`
- `started_at`
- `last_event_at`
- `status`
- `source_ref`

Optional fields:

- `completed_at`
- `task_title`
- `workdir`
- `repo`
- `branch`
- `cost_estimate`
- `runtime_seconds`

### Event

A normalized activity record.

Required fields:

- `event_id`
- `agent_profile_id`
- `agent_run_id`
- `timestamp`
- `source_platform`
- `event_type`
- `summary`
- `evidence_level`

Optional fields:

- `raw_payload_path`
- `artifact_links`
- `repo`
- `commit_sha`
- `pr_url`
- `issue_url`
- `tool_name`
- `operator_action`
- `severity`
- `confidence`
- `sensitivity_level`

### TaskThread

The report's decided primary grouping (added 2026-07-15; not yet shipped — no TaskThread type, derivation, or rendering exists in code, where reports remain a flat list of per-profile cards. Tracked as bead asl-1wm.) A single task routinely spans multiple runs — an orchestrator session, its dispatched subagents, a follow-up session the next morning — and a run-by-run report fragments that story. A TaskThread groups those runs into one task-level narrative.

Threads are keyed by, in preference order:

1. **Bead ID** (issue-tracker ID): when runs reference the same tracked issue, they belong to the same thread.
2. **File cluster**: when no issue ID is available, runs that touch the same cluster of files within a repo are grouped heuristically.

Required fields:

- `task_thread_id`
- `thread_key`: bead ID or file-cluster signature
- `title`
- `agent_run_ids`
- `status`: rolled up from member runs, exceptions-first

Optional fields:

- `repo`
- `first_activity_at`
- `last_activity_at`
- `evidence_level`: the strongest evidence any member run produced

TaskThreads will be derived at report time from runs and events (consistent with the stateless-scan architecture in ADR 0002); they are a reporting construct, not a fourth ingestion object. The per-agent sections will remain, but the digest will lead with threads: the operator's question is "how is the task going," not "what did session N do." Until asl-1wm ships, the digest continues to lead with the exceptions-first per-profile rollup.

---

## 8. Status and Evidence Model

### Status values

- `active`
- `idle`
- `completed`
- `blocked`
- `failed`
- `silent`
- `needs_human`

### MVP status rules

These thresholds should be configurable, but MVP needs defaults.

- **Active:** at least one progress event in the last 2 hours.
- **Idle:** no progress event in the last 2 hours, but no open task or failure.
- **Silent:** task started, no completion event, and no progress event for 6 hours.
- **Completed:** explicit completion event, or artifact produced with no open blocker and optional verification.
- **Blocked:** explicit blocker, approval request, missing credential, failing dependency, or unresolved decision.
- **Failed:** terminal error, failed command, failed CI, unrecovered exception, or connector-level failure.
- **Needs human:** approval, review, decision, credential, merge, or ambiguous artifact requires operator action.

### Evidence levels

- **Proven:** backed by durable artifact such as commit, PR, issue update, CI result, log entry, or generated file.
- **Partially proven:** supported by transcript or message plus some artifact evidence.
- **Claimed only:** based only on agent natural-language output.
- **Unknown:** imported record exists, but source quality is insufficient.

### Provenance axis (decided 2026-07-15, not yet shipped)

Evidence level answers "how well is this claim backed?" Provenance answers a different question: "who asked for this work?" This axis is decided but not implemented — no provenance field exists on runs or claims and no inference runs today; tracked as bead asl-ami. Once shipped, every run and reported claim will carry one of two provenance values:

- **`user_directed`**: the work traces to an explicit operator instruction — a prompt the operator typed, a bead the operator filed, a task the operator dispatched.
- **`agent_initiated`**: the work was undertaken by an agent on its own judgment — a subagent fan-out, a self-filed follow-up, an autonomous fix.

Provenance is orthogonal to evidence: an agent-initiated change can be fully proven, and a user-directed task can be claimed-only. The report will surface both axes because they drive different operator behavior — proven-but-agent-initiated work still deserves a "did I want this?" review, which evidence level alone cannot flag. Subagent runs attached via dispatch-marker lineage will default to `agent_initiated` unless the dispatch traces back to an explicit operator instruction in the orchestrator run.

### Severity values

- **Info:** useful update, no action required.
- **Warning:** possible issue, review recommended.
- **Urgent:** blocked/failed/silent in a way that may require immediate operator action.

### Operator actions

- `none`
- `review`
- `approve`
- `fix`
- `investigate`
- `provide_input`
- `merge`
- `rerun`

---

## 9. Core User Experience

### Daily digest flow

Every morning, the operator receives a digest.

The digest starts with exceptions:

- Blocked agents
- Failed agents
- Silent agents
- Agents needing approval or review
- Artifacts awaiting review

Then it shows per-agent reports:

- What I worked on in the last 24 hours
- What I completed
- What I am still working on
- What blocked me
- What artifacts I produced
- What verification I ran
- What I am unsure about
- What I recommend next

Finally, it includes a rollup:

- Completed work by project
- Active work by project
- Human decisions needed
- Cost/runtime summary where available
- Suggested priorities for the day

### Example report

```text
Agent Standup: Last 24 Hours

Exceptions
- Claude Code / AnxiLog: blocked on failing iOS build. Needs signing-profile decision.
- OpenClaw Ralph / QA: silent for 6h after starting simulator test.
- Codex CLI / Blog: completed draft, needs review.

Agent: Claude Code, AnxiLog iOS
Status: Blocked
Severity: Warning
Worked on: Paywall layout fix and iOS simulator QA.
Completed: Adjusted tab bar visibility and X dismiss behavior.
Artifacts: commit abc123, screenshot /artifacts/anxilog-paywall.png
Verification: simulator build passed; visual QA partially complete.
Needs: confirm whether to keep Maybe Later visible on annual plan screen.
Evidence: Proven for code changes, partially proven for visual QA.
Recommended action: Review screenshot, then rerun simulator flow.

Agent: Codex CLI, Blog Repo
Status: Completed
Severity: Info
Worked on: PRD research draft cleanup.
Completed: Created Markdown draft and linked source notes.
Artifacts: /memory/drafts/agent-status-ledger-prd.md
Verification: structure pass complete.
Needs: G review.
Evidence: Proven.
Recommended action: Review PRD draft.
```

---

## 10. Connector Strategy

The system should use connector plugins. Each connector contributes whatever evidence it can prove.

### Class 1: Native/local collectors

These are the MVP foundation.

Targets:

- OpenClaw session and subagent history
- Ralph/Hermes completion signals
- Git commits, branches, PRs, issues, and CI results
- Claude Code local logs
- Codex CLI local history/logs
- Gemini CLI or OpenCode logs where available

Why this works:

- Local tools leave files behind.
- Workdir/repo can identify scope.
- Artifacts are inspectable.
- No fragile web scraping is required.

### Candidate ingestion substrate: Engram (added 2026-07-14)

[Engram](https://github.com/clickety-clacks/engram) (Mike Manzano, Rust, Apache 2.0) is a provenance index for agent-driven work that already implements most of the Class 1 collection layer. It parses harness session logs into normalized, immutable event tapes and fingerprints them into SQLite.

Overlap with this PRD:

- **Adapters already built and fixture-tested** for Claude Code, Codex CLI, OpenClaw, Cursor, Gemini CLI, and OpenCode — the same sources budgeted for weeks 2 and 4 of the build plan.
- **Harness-independent event contract** (`msg.in/out`, `tool.call/result`, `code.read/edit`, `meta`) that maps cleanly onto this PRD's Event model, with explicit per-ingest coverage grades (`full|partial|none`) that map onto evidence levels.
- **`engram watch`** is a continuous local collector over harness transcript directories.
- **Dispatch markers** (`<engram-src id="<uuid>"/>` prepended to handoff prompts) give deterministic orchestrator-to-subagent run lineage — stronger than timestamp/repo correlation for attaching runs to agent profiles.

Division of labor if adopted: Engram stays the evidence index (it deliberately does no status inference, summarization, or delivery); this product remains the reporting layer that consumes it. Engram's fingerprint matching could also mechanically upgrade "claimed only" completions to "partially proven" by matching claim text to actual code-edit events in the same tape.

Decision needed before week 2 connector work: consume Engram tapes as the normalized event source vs. write our own parsers. Risks to weigh: early-stage project (v0.2.x, single maintainer), partial Codex coverage (generic shell edits are a known gap), build-from-source install. The dispatch-marker convention is worth adopting in orchestrated dispatches regardless of this decision — it is plain text in a prompt and costs nothing.

**Decided (2026-07-15 fidelity review):** the product keeps its own harness parsers as the event source; Engram is consumed as an optional, fail-soft enrichment layer — corroborating claimed-only completions up to partially-proven, and supplying dispatch-marker lineage for the orchestrator-anchored identity model (§7). The dispatch-marker convention was adopted. Privacy consequences of the Engram archive are covered in §13.

### Class 2: Export/import collectors

These make web/app agents feasible without brittle scraping.

Targets:

- ChatGPT official export
- Claude.ai official export
- Browser-extension exports to Markdown/JSON
- Manually dropped transcripts
- Shared conversation URLs where accessible

Pattern:

- User exports or drops files into a watched folder.
- The system parses them, identifies agent profiles/runs, and imports events.
- Reports label imported web/app activity as export-based.

### Class 3: MCP/browser bridge collectors

These are powerful but post-MVP.

Potential tools:

- Browser MCP
- Browserless MCP
- Playwright MCP
- browser-use MCP
- ChatGPT automation MCPs
- ChatGPT desktop MCP adapters
- Claude conversation exporters
- Claude Code exporter MCPs

Use cases:

- Pull recent conversation metadata from a logged-in browser.
- Export selected conversations.
- Capture web-agent output when official APIs are unavailable.

Risks:

- Fragile auth/session behavior
- UI changes
- Vendor restrictions
- Privacy/security concerns

Recommendation: keep this optional until local and export-based connectors prove the core product.

---

## 11. MVP Scope

### MVP objective

Prove that agent work can be collected from reliable local sources, normalized into agent profiles/runs/events, and turned into a useful daily report.

### MVP v0 connectors

Amended per ADR 0001 (2026-07-07), which reversed the original ordering: a machine survey showed heavy Claude Code and Codex activity and a dormant OpenClaw, so the first connectors target the sources with real daily work. This is what shipped.

1. **Claude Code local JSONL logs**
2. **Codex CLI local history/logs**
3. **Git activity correlation** for commits, branches, PRs, issues, and CI where accessible

### Phase 1.5 connectors

Add after MVP v0 proves the report format:

- OpenClaw/Ralph/Hermes session history and completion signals
- Gemini CLI/OpenCode logs where practical
- Manual import folder for transcripts, notes, or pasted agent reports

### MVP outputs

- Local Markdown report
- Structured JSON report
- Per-agent sections
- Exceptions-first rollup
- Evidence links
- Email digest with the full HTML report attached (amended 2026-07-15; originally a Telegram summary — see §16)

### MVP exclusions

- Fully automated ChatGPT/Claude web scraping
- Mobile app capture
- Enterprise admin dashboard
- Real-time orchestration/control
- Full LLM trace/eval observability
- Slack/SMS/Telegram delivery (email is in scope as the canonical channel — amended 2026-07-15)

---

## 12. MVP Acceptance Criteria

The MVP is acceptable when the following are true.

### Agent identity

- Given three known agent runs from Claude Code/Codex CLI session history (per ADR 0001), the system creates distinct agent profiles and agent runs.
- Given multiple runs in the same workdir/repo, the system attaches them to the same agent profile unless explicitly configured otherwise. (Reflects shipped workdir-based identity; to be superseded when the orchestrator-anchored model decided in §7 ships.)
- Given a manually imported transcript, the system can attach it to an existing agent profile or create a new one. (Phase 1.5 — the manual import folder ships after MVP v0; see §11.)

### Evidence correlation

- Given a commit created during an agent run window, the report links that commit as evidence.
- Given a PR or issue update associated with the same repo and time window, the report links it as evidence.
- Given no durable artifact, the report marks the update as claimed-only or partially proven.

### Status detection

- Given a started run with no events for 6 hours and no completion, the system flags it as silent.
- Given a run with an error marker or failed command, the system flags it as failed or blocked.
- Given a run with a completion signal and artifact, the system flags it as completed.
- Given an approval request or human decision marker, the system flags it as needs-human.

### Report generation

- The system generates a daily Markdown report without manual editing.
- The system generates a structured JSON report from the same underlying ledger.
- The report includes exceptions first.
- Each agent section includes status, evidence level, artifacts, and recommended operator action.

### Delivery

- The system writes the full report to a configured local path.
- The system sends an email digest containing exceptions, with the full HTML report attached (amended 2026-07-15; originally a Telegram summary — see §16).
- The email digest never includes raw transcripts by default.

### Validation

- A golden fixture set exists with at least three sample runs:
  1. completed with commit
  2. blocked with error log
  3. silent/stalled
- A test can compare generated Markdown/JSON against expected fixture output.

---

## 13. Privacy and Security Requirements

Agent Status Ledger should be local-first by default.

### MVP privacy rules

- Raw transcripts are never sent externally by default.
- Delivery summaries (the email digest, and any future channel such as Telegram) include only concise summaries and statuses, with the full HTML report as an attachment — never raw transcript content.
- Reports include local artifact paths or links, not full sensitive content, unless explicitly configured.
- A redaction pass runs before report generation to catch obvious secrets, tokens, API keys, credentials, and private keys.
- Source sensitivity labels propagate to events and reports.
- The ledger stores raw payload paths separately from generated summaries.

### The Engram archive (added 2026-07-15)

When the Engram connector is enabled, `~/.engram` holds Engram's local index of **verbatim, unredacted session tapes** — everything the harness said, ran, and read, fingerprinted into SQLite. Treat it accordingly:

- `~/.engram` is a raw source, on the same footing as harness transcript directories. It never leaves the machine and is never quoted into report output directly.
- Deleting a harness transcript does not delete its tape; retention of `~/.engram` is Engram's concern, but this product must assume the archive contains every secret that ever crossed a session.

### Redaction choke point for tape-sourced text (mandated 2026-07-15)

Any string that originates in Engram tape output and enters report output MUST pass through `sanitizeTapeText` at the point it is parsed into a report data structure — never at render time, so no future render path can bypass it. The contract:

- **Branded output.** `sanitizeTapeText` is the single sanctioned producer of the branded `SanitizedTapeText` type; report fields that quote tape content declare that type, so the compiler flags any code path that skipped the choke point.
- **Redact → strip → redact.** The secret-redaction pass runs on both sides of a structural strip of Unicode default-ignorables and other tape-unsafe characters. Each single-pass order has an inverse evasion: strip-first lets stripped characters glue adjacent text onto a secret so boundary rules stop matching; redact-first lets a secret split by an invisible character slip past as fragments and reassemble after the strip. Running redaction on both representations closes both.
- **Required `extraPatterns`.** The user's configured redaction patterns are a required argument with no default. A call site that drops them must do so visibly, by passing `[]` — a silently defaulted empty list is exactly how user patterns get lost.

### Future privacy features

- Per-source retention policies
- Per-agent sensitivity levels
- Local-only mode
- Optional encrypted ledger
- Configurable cloud-model usage for summaries
- Audit trail for every external delivery

---

## 14. Local Ledger

The ledger should be append-first. Summaries should be derived from events, not used as the only record.

### MVP storage

SQLite is sufficient for MVP. A Beads-like local issue/task substrate may be useful if it provides:

- Local-first storage
- CLI access
- Structured entities
- Status fields
- Artifact links
- Workdir/repo scoping
- Markdown/JSON export

Recommendation: use SQLite for v0 unless Beads already provides the required primitives with less work.

### Required event types for MVP

- `agent_seen`
- `run_started`
- `run_progressed`
- `artifact_created`
- `commit_created`
- `pr_opened`
- `issue_updated`
- `verification_run`
- `approval_requested`
- `blocked`
- `failed`
- `completed`
- `silent_detected`
- `manual_note_added`
- `transcript_imported`

---

## 15. Reporting Logic

For each agent profile active in the last 24 hours:

1. Collect associated runs and events.
2. Group events by run/task.
3. Infer status using MVP status rules.
4. Attach evidence and artifact links.
5. Generate a concise agent report.
6. Assign evidence level, severity, and operator action.
7. Add the agent to the exceptions section when appropriate.

Reports should prefer grounded language:

- “Created commit abc123” instead of “finished the task.”
- “Agent claimed completion, but no artifact was found” instead of “completed.”
- “No events for 6h after start” instead of “probably stuck.”

---

## 16. Delivery

Amended 2026-07-15: email replaced Telegram as the canonical delivery channel. Email delivery shipped and has been operational since 2026-07-14; Telegram was never built and is repositioned as an optional future channel.

### Shipped delivery (canonical)

- Full local Markdown file
- Full local JSON file
- Self-contained local HTML standup page (see ADR 0005)
- **Email digest** (Gmail SMTP): exceptions-first inline summary with the full HTML report attached — the canonical remote channel, operational since 2026-07-14

### Future delivery (optional)

- Telegram exceptions summary
- Slack channel or DM
- SMS/text
- Local dashboard beyond the static HTML page
- Webhook/API
- Weekly rollup

---

## 17. Build Plan

### Week 1: Local ledger and fixtures

- Define SQLite schema for agent profiles, runs, and events.
- Build manual event importer.
- Build sample fixture set.
- Generate Markdown and JSON reports from fixtures.
- Add golden-file tests.

### Week 2: Claude Code/Codex + Git correlation (amended per ADR 0001; originally OpenClaw/Ralph/Hermes)

- Build Claude Code log parser.
- Build Codex CLI parser.
- Build Git connector for commits, branches, PRs/issues where available.
- Correlate events by repo/workdir/time window.
- Implement status inference and evidence levels.
- Produce first real daily report.

### Week 3: Delivery and quality

- Add email digest delivery (amended 2026-07-15; originally Telegram — see §16).
- Add redaction pass.
- Add report path/archive structure.
- Add config file for thresholds and source paths.
- Run daily on real activity.

### Week 4: Connector expansion (amended per ADR 0001; originally Claude Code/Codex)

- Add OpenClaw/Ralph/Hermes connector.
- Add import folder for web/app exports.
- Improve agent profile resolution.

---

## 18. Success Metrics

### MVP success

- Operator can understand yesterday’s agent work in under five minutes.
- At least three distinct agent profiles are reported correctly.
- Completed, blocked, failed, and silent statuses are detected in fixtures.
- Every report claim has an evidence level.
- Report generation requires no manual editing.
- Email digest carries the full report as an attachment.

### Product success

- Less time spent manually checking agent status.
- Fewer missed completions or silent failures.
- Increased confidence in agent-produced work.
- More reuse of prior agent work because history is searchable.
- Morning digest becomes the default starting point for AI work.

---

## 19. Open Questions

1. ~~Should an agent profile map primarily to workdir, repo, user-assigned name, or tool session identity?~~ **Resolved 2026-07-15** (decided; not yet shipped — see §7). Agent identity will anchor to orchestrator runs; subagent runs will attach to their orchestrator as a lineage tree discovered via dispatch markers (`<engram-src id="<session-uuid>"/>` prepended to every Agent-tool dispatch prompt). Rationale: the orchestrator run is the unit the operator actually started and can be held accountable, and the dispatch marker gives deterministic lineage where workdir/timestamp correlation only guesses. Caveat: lineage history only accrues from adoption of the marker convention — pre-adoption subagent runs stay unattributed. See §7.
2. What is the right default silent threshold: 2h, 6h, or 24h?
3. Should summarization run entirely local by default, or is configurable cloud summarization acceptable?
4. How much raw transcript should be retained?
5. How should manually imported ChatGPT/Claude exports be assigned to durable agent profiles?
6. Should the report distinguish “agent did work” from “agent helped human think through work”?
7. Should Beads be used as the user-visible ledger, or remain an implementation detail?
8. ~~What is the best long-term delivery surface: Telegram, Slack, email, dashboard, or all of them?~~ **Resolved 2026-07-15.** Email is the shipped canonical delivery channel, operational since 2026-07-14. Rationale: email needed no bot setup or third-party account, the digest-plus-attached-report pattern fits it naturally, and it proved itself in daily use before any alternative was built. The local static HTML page (ADR 0005) covers the dashboard need. Telegram, Slack, SMS, and webhooks remain optional future channels layered on the versioned JSON report. See §16.

---

## 20. Final Positioning

Agent Status Ledger is the morning operating report for your AI workforce.

It gives every agent a durable identity, every claim an evidence level, and every operator a clear answer to:

> What happened while I was away?

The first version should stay narrow: local-first, agent-only, evidence-backed, and useful before web/app automation exists.

The long-term opportunity is bigger. As agent work spreads across web apps, CLIs, IDEs, orchestration tools, and cloud coding environments, operators will need a trusted system of record. The product becomes valuable because it does not assume one vendor wins. It watches the work wherever it happens, then turns the mess into a daily report a human can act on.
