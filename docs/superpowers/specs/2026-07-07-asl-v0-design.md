# Agent Status Ledger v0 — Design

Date: 2026-07-07
Status: Approved
Decisions: see docs/adr/0001–0005. Where this spec and PRD.md disagree, the
ADRs win.

## Goal

A local CLI that answers, each morning: **what did the AI agents on this
machine do in the last 24 hours, what finished, what failed, and what needs
me?** Sources for v0 are Claude Code and Codex CLI session logs plus local
git history. Output is a Markdown report, a JSON report, and a
self-contained HTML standup page.

## Shape

TypeScript on Bun. One command:

```
asl report [--since 24h] [--open] [--no-llm] [--out DIR]
```

No daemon, no database (ADR 0002). Each run scans fresh, builds the report
in memory, writes `reports/YYYY-MM-DD.{md,json,html}`.

## Pipeline

Four stages communicating only via normalized objects (PRD §7 shapes:
AgentProfile, AgentRun, Event):

```
connectors → resolver → git correlator → reporter
```

### 1. Connectors

Interface: `scan(since: Date) → RawSession[]`, where a RawSession carries
source platform, session id, cwd, start/last-event timestamps, title if
available, and a normalized Event list.

- **claude-code**: reads `~/.claude/projects/<encoded-cwd>/*.jsonl` with
  mtime in window. Decodes cwd from the directory name (verify against
  `cwd` fields inside entries when present). Maps line types: `user` /
  `assistant` turns → `run_progressed`; tool-use results with error
  markers → `failed`/`blocked` signals; `ai-title` → session title;
  `file-history-snapshot` → files touched. Sidechain (subagent) entries
  fold into the parent session.
- **codex**: reads `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` for dates
  in window; `session_meta` supplies cwd/source/model; `session_index.jsonl`
  supplies thread names and `updated_at`.

Parse failures on any file log a warning and skip the file — a bad session
never kills the report. Unknown line types are ignored by design (vendor
formats change often; this is the accepted risk).

### 2. Resolver

Groups sessions into Agent Profiles keyed `platform:workdir`
(e.g. `claude-code:~/github/anxilog`). All in-window sessions with the same
key share a profile; each session is an AgentRun under it. Profile display
names derive from the workdir basename plus platform.

### 3. Git correlator

For each profile whose workdir is a git repo: `git log --since=<window>`
collects commits and branch activity. A commit attaches as **proven**
evidence only when its author time falls inside one of that profile's run
windows. Commits outside every run window are listed under the profile's
repo as unattributed context, never as agent evidence (guards against
crediting human commits to agents). Local git only; no GitHub API in v0.

### 4. Reporter

- **Status inference** (PRD §8 rules, thresholds configurable): active,
  idle, completed, blocked, failed, silent (no events 6h after start),
  needs_human. Stateless caveat: silent detection covers only runs whose
  start is inside the scan window.
- **Evidence levels** per claim: proven / partially proven / claimed only /
  unknown (PRD §8).
- **Redaction pass** over extracted facts (secret/token/key regexes) before
  any LLM call and again over the final report.
- **Narrative** (ADR 0003): one Claude Haiku call per active profile.
  Input: the structured fact sheet (files touched, commands, errors,
  commits, titles, status). Never raw transcripts. The LLM writes the prose
  sections only; status, evidence levels, and artifact links are computed
  before the call and cannot be altered by it. `--no-llm` renders
  template-only.

## Outputs

Written per run to the reports directory (ADR 0005):

- `YYYY-MM-DD.md` — exceptions first, then per-agent sections
  (worked on / completed / in progress / blocked / artifacts /
  verification / needs / recommended action), then rollup.
- `YYYY-MM-DD.json` — same data, versioned schema (`schema_version: 1`);
  the contract for future delivery surfaces (board app, Telegram).
- `YYYY-MM-DD.html` — self-contained standup page (inline CSS/JS, no
  external requests), exceptions-first; `--open` opens it.

## Config

`~/.config/asl/config.toml`, all optional (zero-config first run):
thresholds (active/silent windows), reports dir, model name, per-connector
enable/disable, extra redaction patterns.

## Testing

Golden fixtures per PRD §12: synthetic session sets checked into
`fixtures/` covering (1) completed with commit, (2) blocked with error,
(3) silent/stalled, plus a mis-attribution case (human commit outside run
windows must not attach as evidence). Snapshot tests compare generated
Markdown and JSON; the LLM step is mocked. `bun test` runs the suite.

## Explicitly out of scope for v0

SQLite ledger, OpenClaw/Gemini/web-export connectors, GitHub API, Telegram
or any push delivery, the interactive board app, cost tracking, real-time
monitoring.

## Risks

- **Vendor log formats are undocumented and change**: mitigated by
  skip-and-warn parsing and fixture tests that pin what we rely on.
- **Attribution errors** (human work credited to agents): mitigated by the
  run-window rule and the mis-attribution fixture; confidence scoring can
  come later with the ledger.
- **LLM narrative drift**: bounded by feeding facts only and locking
  status/evidence outside the LLM.
