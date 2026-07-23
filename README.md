# Agent Status Ledger

A daily standup for every AI agent you run.

Local-first activity ledger and daily reporting system for AI agents. Every meaningful agent workstream gets a durable identity, every claim gets an evidence level, and the operator gets one morning answer: what did my agents do yesterday, what finished, what failed, and what needs me?

The full product spec is in [PRD.md](PRD.md) (draft v2, 2026-06-27).

## Current state

Working CLI with a morning report, email delivery, and a localhost dashboard.
Run the morning report:

    bun install
    bun run src/cli.ts report --open          # LLM narratives if ANTHROPIC_API_KEY is set
    bun run src/cli.ts report --no-llm        # fully local, template narratives
    bun run src/cli.ts doctor                 # verify setup (Anthropic key, email, connectors, dashboard)

Writes `reports/YYYY-MM-DD.{md,json,html}`. Sources scanned: Claude Code
(`~/.claude/projects`) and Codex (`~/.codex/sessions`), plus git commit
correlation per workdir. Engram is an optional, disabled-by-default enrichment
connector (task threads, provenance) rather than a log source.

### Dashboard

    bun run src/cli.ts serve                  # localhost dashboard on 127.0.0.1:4680

Serves the latest report plus the archive on `127.0.0.1:<dashboard_port>` (default
4680). `POST /api/refresh` re-runs the report (`--no-email`) behind a single-run
mutex and a CSRF origin guard; `/api/status` reports the last dashboard-initiated
refresh (not scheduled/external report runs). `asl doctor` includes an advisory
probe that the dashboard is responding. An example KeepAlive launchd plist lives
at `scripts/com.gd.asl-dashboard.plist` — edit its hardcoded paths for your
machine before loading it.

### Configuration

Config file: `~/.config/asl/config.toml` (all optional). Example:

```toml
reports_dir = "reports"        # default: ./reports
dashboard_port = 4680          # default: asl serve bind port (localhost only)

[email]
to = "you@example.com"         # required to enable email delivery
from = "you@example.com"       # default: same as `to`
smtp_host = "smtp.gmail.com"   # default
smtp_port = 465                # default

[thresholds]
active_window_hours = 2        # default
silent_threshold_hours = 6     # default
min_session_seconds = 60       # default: hide a profile only if ALL its sessions
                               # are shorter than this AND touched no files, hit no
                               # errors, produced no attributed commit, and weren't mid-work

[connectors.claude_code]
enabled = true                 # default
# root_dir defaults to <home>/.claude/projects; override with an absolute path

[connectors.codex]
enabled = true                 # default
# root_dir defaults to <home>/.codex; override with an absolute path

[connectors.engram]
enabled = false                # default: opt-in enrichment connector
binary_path = "engram"         # default
bead_prefixes = []             # issue-tracker prefixes to correlate task threads
```

`root_dir` is stored verbatim — a literal `~` is not expanded, so overrides must
be absolute paths.

**Email delivery setup:** Emails the finished report via SMTP (Gmail by default).
The mailer uses implicit TLS (`smtps://`), so `smtp_port` must be an implicit-TLS port — Gmail's default port **465** works; port **587** (STARTTLS) is not supported and will fail with opaque curl errors.
One-time setup: create an app password at https://myaccount.google.com/apppasswords
(requires 2-Step Verification), then store it in the macOS keychain:

```bash
security add-generic-password -s gmail-app-password -a asl -w "<app password>"
```

`ASL_SMTP_PASSWORD` environment variable overrides the keychain. Skip a send with
`--no-email`. The `asl doctor` command verifies the email config and password.
Send failures print a warning but never fail the report run.

### Report flags

- `--no-llm`: Use template narratives instead of LLM-generated ones (no Anthropic API call)
- `--no-email`: Skip email delivery even if configured
- `--open`: Open the HTML report in the default browser
- `--since 24h`: Hours or days of logs to scan (default: 24h)
- `--layout cards|flat`: HTML report layout (default: cards)
- `--out DIR`: Write reports to DIR instead of the configured `reports_dir` (default `./reports`)

- [PRD.md](PRD.md) — product spec (amended by docs/adr/)
- [docs/superpowers/specs/2026-07-07-asl-v0-design.md](docs/superpowers/specs/2026-07-07-asl-v0-design.md) — v0 design

## Origin

Idea pitched as "WorkingOn for agents" (2026-06-27); PRD drafted the same day. Prior art noted in the PRD: DailyBot Agent Heartbeat, beads viewer, AI-digest, LangSmith-class observability tools.
