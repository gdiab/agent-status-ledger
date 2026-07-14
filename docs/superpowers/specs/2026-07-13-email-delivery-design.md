# Email Delivery of the Morning Report (asl-533)

**Date:** 2026-07-13
**Bead:** asl-533
**Status:** Approved design

## Goal

Deliver the morning report to the user's inbox in addition to the existing
launchd-driven browser tab. Channel decision: email first (user pick).
Transport: Gmail SMTP with an app password stored in the macOS keychain.

## Decisions (locked with user)

| Decision | Choice |
|---|---|
| Transport | Gmail SMTP, app password in macOS keychain |
| Trigger | Config-driven auto-send at the end of `asl report`; `--no-email` flag opts out per run |
| Body | `multipart/alternative`: markdown render as `text/plain`, self-contained HTML report as `text/html` |
| SMTP mechanism | Shell out to macOS built-in `curl` (`smtps://`), no new dependencies |
| Failure mode | Send failure warns on stderr, run still exits 0 (report files are the primary artifact; browser tab must still open) |

## Config

New optional `[email]` section in `~/.config/asl/config.toml`:

```toml
[email]
to = "user@example.com"        # required — presence of a valid `to` enables the feature
from = "user@example.com"      # optional, defaults to `to`
smtp_host = "smtp.gmail.com"   # optional default
smtp_port = 465                # optional default
```

- `Config` interface gains `email?: EmailConfig` (`to`, `from`, `smtpHost`, `smtpPort`).
- `defaultConfig()` has no `email` (feature off by default).
- `loadConfig` overlays the section with the same per-field type guards as
  `connectors`: a malformed `[email]` (missing/non-string `to`) degrades to
  disabled, never crashes.

## Credential resolution

- New keychain service constant `gmail-app-password`, account `asl` — same
  one-service/account-per-project convention as `anthropic-api-key`.
- `resolveSmtpPassword(env, keychain)` mirrors `resolveApiKey`
  precedence: `ASL_SMTP_PASSWORD` env var → keychain(`gmail-app-password`, `asl`).
  Whitespace-trimmed; empty values ignored. Uses the existing injected
  `KeychainLookup` type; reuses `macKeychainLookup` at the CLI edge.
- Nothing ever writes to the keychain. User provisions once:
  `security add-generic-password -s gmail-app-password -a asl -w "<app password>"`.

## Send path — `src/email.ts`

Two units with injected seams:

1. **`buildMimeMessage({from, to, subject, html, text}) → string`** — pure.
   Assembles an RFC 2822 message: headers (`From`, `To`, `Subject`, `Date`,
   `MIME-Version`, `Message-ID`), `multipart/alternative`, `text/plain` part first, `text/html` part second, both
   encoded `quoted-printable` (UTF-8) for non-ASCII safety.
   `Date`, `Message-ID`, and the multipart boundary are injected parameters so
   the function stays deterministic and golden-testable.

2. **`sendEmail(emailConfig, password, mime, deps) → {ok, error?}`** — shells
   out to curl via an injected exec seam (same shape as doctor's `Exec`).
   To keep the password out of process argv (visible in `ps`):
   - create a private temp dir (mode 700),
   - write a curl config file (mode 600) containing `user = "<from>:<password>"`,
   - write the MIME message to a `.eml` file,
   - run `curl -sS --url smtps://<host>:<port> --mail-from <from> --mail-rcpt <to> -K <cfg> -T <eml>`,
   - delete the temp dir in a `finally`.
   Non-zero curl exit → `{ok: false, error}` with curl stderr included.

## CLI integration — `src/cli.ts`

- New `--no-email` boolean flag in the existing `parseArgs` options; added to `USAGE`.
- At the end of the `report` flow, after the redacted `.md`/`.html` files are
  written: if `config.email` is set and `--no-email` absent, resolve the
  password and send, reusing the already-redacted markdown and HTML strings in
  memory (never re-read from disk, never pre-redaction content).
- Subject: `ASL — YYYY-MM-DD` plus headline rollup counts from the existing
  rollup helper (e.g. `ASL — 2026-07-13: 2 blocked, 5 active`).
- Missing password with email configured → same non-fatal stderr warning path
  as a failed send (with the `security add-generic-password` hint).
- Send failure: stderr warning with the error, exit code unchanged (0 on an
  otherwise successful report). `scripts/morning-report.sh` needs no changes.

## Doctor — `src/doctor.ts`

When `config.email` is set, `runDoctor` gains checks (skipped entirely when
email is unconfigured):

- **email-config**: `to` present and plausible (`x@y` shape), port is a number.
- **email-password**: keychain entry `gmail-app-password`/`asl` resolves (or
  env override present). Fix hint: the `security add-generic-password` command.

Both follow the existing injected `config` + `Exec`/`KeychainLookup` patterns.

## Testing

All via injected seams — no network, no real keychain, no real `security`/`curl`:

- `buildMimeMessage` golden test (fixed date/message-id/boundary inputs);
  cases for non-ASCII content and header escaping in subject.
- Config overlay: full section, minimal (`to` only → defaults applied),
  malformed (`to` missing, wrong types) → feature disabled, no crash.
- `resolveSmtpPassword` precedence: env beats keychain, empty/whitespace ignored.
- `sendEmail` with fake exec: correct curl argv, config-file contents contain
  the credential, temp dir cleaned up on success and on failure.
- Doctor: checks appear only when email configured; pass/fail/fix-hint cases.
- CLI: `--no-email` suppresses send; unconfigured email never attempts send.

## Out of scope

- Other channels (Slack, phone-friendly page) — remain on asl-533's parent scope.
- Attachments, multiple recipients, non-Gmail providers beyond what
  `smtp_host`/`smtp_port` config already allows.
- Keychain writes or interactive credential setup.
