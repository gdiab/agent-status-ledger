#!/bin/bash
# Morning ASL run, invoked by launchd (com.gd.asl-report). launchd provides no
# shell environment, so bun is addressed absolutely and the API key comes from
# the keychain via the CLI's resolver chain.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
BUN="$HOME/.bun/bin/bun"
CHROME_PROFILE="Default" # Chrome profile directory, not display name

cd "$REPO"
"$BUN" run src/cli.ts report

DAY="$(date +%F)"
open -na "Google Chrome" --args --profile-directory="$CHROME_PROFILE" "file://$REPO/reports/$DAY.html"
