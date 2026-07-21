# Dashboard Web Server (asl-eia) — Design

**Date:** 2026-07-20
**Bead:** asl-eia
**Status:** Approved approach A (standalone `asl serve` + launchd KeepAlive)

## Goal

A local dashboard serving the latest HTML report and the historical archive,
with an on-demand refresh. Dissolves the web-font constraint (assets served
locally) and becomes the historical view. Report *generation* (the 7:30
launchd run, email delivery) is untouched.

## Decisions (George, 2026-07-18/20)

- **Scope:** latest + history browser, plus on-demand refresh. No live/hourly
  auto-regeneration in v1.
- **Refresh semantics:** manual refresh overwrites today's
  `reports/<date>.{html,md,json}` in place via the real CLI with `--no-email`.
  One consistent artifact set; the 7:30 run is just the scheduled instance.
- **Exposure:** localhost only (`127.0.0.1`), no auth. LAN access deferred to
  the remote-machines story (asl-jcm).
- **Lifecycle:** approach A — separate `com.gd.asl-dashboard.plist` with
  `KeepAlive`, independent of the report run. (B: script-ensured server and
  C: server-owned scheduling were considered and rejected — B reinvents
  launchd poorly; C couples email delivery to dashboard uptime.)

## Architecture

- New `serve` subcommand in `src/cli.ts` delegating to **`src/server.ts`**
  (new module). `startServer(config, exec)` returns the `Bun.serve` handle so
  tests can start on port 0 and stop it.
- Binds `127.0.0.1` on `dashboard_port` from config (default **4680**).
- Reads `config.reportsDir` per request — no caching, no in-memory report
  state — so the scheduled run's writes appear immediately.
- Launchd: `com.gd.asl-dashboard.plist`, `KeepAlive: true`, `RunAtLoad: true`,
  logs to `~/Library/Logs/asl-dashboard.log`. Plist loaded = enabled; no
  `dashboard_enabled` config key.

## Routes

| Route | Behavior |
|---|---|
| `GET /` | Today's report if present, else most recent; wrapped in header bar |
| `GET /r/:date` | Specific day (`YYYY-MM-DD` validated; filename constructed, never taken from the path — traversal-proof) |
| `GET /archive` | Index of available dates, newest first, from `readdir(reportsDir)` |
| `GET /api/reports` | JSON list of dates (feeds `/archive`; future asl-jcm surface) |
| `POST /api/refresh` | Spawn report run; 202 on start, 409 if already running |
| `GET /api/status` | `{running, startedAt, lastExit}` — `lastExit` is `{ok, finishedAt}` or null (`ok` from the Exec seam, which collapses exit codes) |

## Refresh mechanics

- Single in-process run state (mutex): `{running, startedAt, lastExit}`.
- Refresh spawns the real CLI (`asl report --no-email`) through the exec
  seam, detached from the request; state updated on exit. Timeout ~10 minutes
  (LLM narrative + connectors exceed the 60s CLI seam, so the server uses its
  own longer-bounded exec).
- Because it's the real CLI subprocess, trends, redaction, and file writes
  behave identically to the scheduled run — no second pipeline.
- A failed run surfaces in `/api/status` (`lastExit.ok: false`) so the UI shows
  "last refresh failed" rather than silently serving stale HTML.
- Header-bar refresh button polls `/api/status` until `running` flips false,
  then reloads.

## Header bar

- Injected by the server around the stored report HTML — files on disk stay
  pristine; email and file rendering unaffected.
- Sticky top strip: report date, prev/next day links, archive link, refresh
  button + status.
- **Design-system constraint:** the chrome's inline stylesheet is built
  exclusively from `src/render/theme.ts` imports (`COLORS_HEX`, `FONT_SANS`,
  `FONT_MONO`, `TEXT_SCALE`, `WEIGHT`, `SPACING`, `RADIUS`, `STATUS_COLORS`
  via `statusCssVars`). No hand-rolled hex values or font stacks — this is
  the drift asl-2h8 is fixing in the digest; the dashboard must not be born
  with it.

## Config

- `dashboard_port` (number, default 4680) added to `src/config.ts` parsing
  with the existing raw-key pattern (`dashboard_port` → `dashboardPort`).

## Doctor

- New check: `GET http://127.0.0.1:<port>/api/status` with a short timeout.
  Server down is a **warning**, not a failure — the dashboard is optional.

## Error handling

- Unknown date → 404 with a link to `/archive`.
- Empty `reportsDir` → friendly "no reports yet" page.
- Malformed date param → 400.
- Refresh spawn failure → recorded in `lastExit` and the mutex released,
  including synchronous exec throws (routed through `Promise.resolve()`), so
  no failure mode can wedge refresh shut.
- `POST /api/refresh` with a present non-local `Origin` → 403 (localhost CSRF
  guard; absent Origin stays allowed for CLI clients).

## Testing

`startServer` on port 0 with a temp `reportsDir` fixture and stubbed exec:

- Route behavior: latest resolution (today vs most-recent fallback), date
  validation, traversal attempts (`/r/..%2f...`), archive listing order.
- Refresh: mutex (second POST → 409), status transitions with a fake
  subprocess exit, failure surfaced in `lastExit`.
- Header bar: report body preserved byte-for-byte inside the wrapper.
- No live LLM, email, or network in tests, matching existing suite patterns.

## Out of scope (v1)

- LAN exposure / auth (asl-jcm).
- Retention policy — reports are small; keep everything.
- Serving anything other than what the report pipeline already writes.
