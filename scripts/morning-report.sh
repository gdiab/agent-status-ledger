#!/bin/bash
# Morning ASL run, invoked by launchd (com.gd.asl-report). launchd provides no
# shell environment, so bun is addressed absolutely and the API key comes from
# the keychain via the CLI's resolver chain.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
BUN="$HOME/.bun/bin/bun"
CHROME_PROFILE="Default" # Chrome profile directory, not display name

# Run from a snapshot of main, never from the working tree: the checkout may
# sit on any branch overnight (asl-91o — a report once silently ran stale v0.2
# code). Fetch all refs (a bare `fetch origin main` may only update FETCH_HEAD
# on some configs); best-effort so an offline morning still reports from the
# local main. origin/main wins when available because PRs merge on GitHub.
git -C "$REPO" fetch --quiet origin || true
REF="main"
if git -C "$REPO" rev-parse --verify --quiet refs/remotes/origin/main >/dev/null; then
  REF="origin/main"
fi

SNAPSHOT="$(mktemp -d)"
trap 'rm -rf "$SNAPSHOT"' EXIT
git -C "$REPO" archive "$REF" | tar -x -C "$SNAPSHOT"

cd "$SNAPSHOT"
# Install against the snapshot's own lockfile — fails loudly on any drift and
# is served from bun's local cache in the steady state (offline-safe after the
# first run). A symlink to the checkout's node_modules could silently run
# version-drifted deps.
"$BUN" install --frozen-lockfile --silent
"$BUN" run src/cli.ts report --out "$REPO/reports"

DAY="$(date +%F)"
open -na "Google Chrome" --args --profile-directory="$CHROME_PROFILE" "file://$REPO/reports/$DAY.html"
