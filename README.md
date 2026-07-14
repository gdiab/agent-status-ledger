# Agent Status Ledger

A daily standup for every AI agent you run.

Local-first activity ledger and daily reporting system for AI agents. Every meaningful agent workstream gets a durable identity, every claim gets an evidence level, and the operator gets one morning answer: what did my agents do yesterday, what finished, what failed, and what needs me?

The full product spec is in [PRD.md](PRD.md) (draft v2, 2026-06-27). Nothing is built yet; this repo exists to iterate on the spec and then hold the implementation.

## Current state

Working v0 CLI. Run the morning report:

    bun install
    bun run src/cli.ts report --open          # LLM narratives if ANTHROPIC_API_KEY is set
    bun run src/cli.ts report --no-llm        # fully local, template narratives
    bun run src/cli.ts doctor                 # verify setup (Anthropic key, email, connectors)

Writes `reports/YYYY-MM-DD.{md,json,html}`. Sources scanned: Claude Code
(`~/.claude/projects`) and Codex (`~/.codex/sessions`), plus git commit
correlation per workdir.

### Configuration

Config file: `~/.config/asl/config.toml` (all optional). Example:

```toml
[email]
to = "you@example.com"         # required to enable email delivery
from = "you@example.com"       # default: same as `to`
smtp_host = "smtp.gmail.com"   # default
smtp_port = 465                # default
```

**Email delivery setup:** Emails the finished report via SMTP (Gmail by default).
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
- `--layout cards|list`: HTML report layout (default: cards)
- `--out DIR`: Write reports to DIR instead of `./reports`

- [PRD.md](PRD.md) — product spec (amended by docs/adr/)
- [docs/superpowers/specs/2026-07-07-asl-v0-design.md](docs/superpowers/specs/2026-07-07-asl-v0-design.md) — v0 design

## Origin

Idea pitched as "WorkingOn for agents" (2026-06-27); PRD drafted the same day. Prior art noted in the PRD: DailyBot Agent Heartbeat, beads viewer, AI-digest, LangSmith-class observability tools.
