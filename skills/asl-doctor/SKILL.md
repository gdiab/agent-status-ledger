---
name: asl-doctor
description: Verify or install an Agent Status Ledger (ASL) setup on macOS. Use when asked to set up ASL, debug why the morning report did not run, or check keychain/launchd/connector prerequisites. Run `asl doctor`, then apply the fix for each failing check.
---

# ASL Doctor

Verify the setup, then fix only what fails. From the repo root:

```bash
bun src/cli.ts doctor    # or: asl doctor, if the bin is linked
```

Exit 0 = healthy. Exit 1 = at least one FAIL; each FAIL prints a `fix:` line. Apply fixes top to bottom, re-run until green.

## Checks and remediation

### 1. bun on PATH
ASL runs on Bun. If missing:
```bash
curl -fsSL https://bun.sh/install | bash
```

### 2. bun at launchd path (`~/.bun/bin/bun`)
launchd provides no shell PATH, so `scripts/morning-report.sh` hardcodes `$HOME/.bun/bin/bun`. The official installer puts bun there. If bun came from Homebrew:
```bash
mkdir -p ~/.bun/bin && ln -s "$(which bun)" ~/.bun/bin/bun
```

### 3. Anthropic API key
Resolver order: `ASL_ANTHROPIC_API_KEY` env, `ANTHROPIC_API_KEY` env, then macOS keychain (service `anthropic-api-key`, account `asl`, then any account). Without a key, reports still build but use template narratives instead of LLM ones. To add the keychain entry:
```bash
security add-generic-password -s anthropic-api-key -a asl -w "<sk-ant-... key>"
```

### 4–5. launchd plist installed and loaded
The morning report runs via launchd label `com.gd.asl-report` at 07:30, executing `scripts/morning-report.sh`. Install (adjust the repo path):
```bash
cat > ~/Library/LaunchAgents/com.gd.asl-report.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.gd.asl-report</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/PATH/TO/agent-status-ledger/scripts/morning-report.sh</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>30</integer></dict>
  <key>StandardOutPath</key><string>/tmp/asl-report.log</string>
  <key>StandardErrorPath</key><string>/tmp/asl-report.log</string>
</dict>
</plist>
EOF
launchctl load -w ~/Library/LaunchAgents/com.gd.asl-report.plist
```
Verify: `launchctl list com.gd.asl-report`. Point StandardOut/ErrorPath somewhere durable (e.g. `~/Library/Logs/asl-report.log`) if preferred.

### 6. config file (`~/.config/asl/config.toml`)
Optional; defaults apply when absent. A TOML parse error fails the check — fix the syntax (ASL itself falls back to defaults with a warning, silently ignoring your settings).

### 7–8. connector log directories
- claude-code: `~/.claude/projects` — created by running Claude Code once.
- codex: `~/.codex` — created by running Codex once.

If logs live elsewhere, override in `~/.config/asl/config.toml`:
```toml
[connectors.claude_code]
root_dir = "/path/to/.claude/projects"
[connectors.codex]
root_dir = "/path/to/.codex"
# or disable one: enabled = false
```

## Smoke test
After all checks pass, prove the pipeline end to end:
```bash
bun src/cli.ts report --since 24h --no-llm
```
