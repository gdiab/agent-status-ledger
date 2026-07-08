# Thermo fixes report — code-quality refactor (behavior-identical)

Branch: `asl-v0`

## Summary

Applied three behavior-identical refactors plus two nits, per code-quality review:

**F1 — Extract shared JSONL scanning core (`src/connectors/jsonl.ts`)**
- New module with exactly three exports:
  - `firstLine(s)` — moved verbatim from `claude-code.ts` and `codex.ts` (was duplicated).
  - `jsonlEntries(text)` — generator implementing the split("\n") → skip blank → try `JSON.parse` → skip on failure idiom. Previously duplicated inline 3x: in `parseClaudeSession`, `parseCodexSession`, and `loadCodexTitles`.
  - `scanSessionFile(path, opts, parse)` — owns `statSync`, the mtime-window check (`mtime < opts.since || mtime > opts.now` → `null`, no log), `readFileSync`, invoking `parse`, the `console.error("warning: no parseable session in <path>")` on a null parse result, and the try/catch around the whole thing with `console.error("warning: skipping <path>: <e>")` on thrown errors → `null`.
- `scanClaudeCode` and `scanCodex` now only walk their own directory layout (encoded project dirs vs `YYYY/MM/DD`, kept per-connector since they're genuinely different), filter `.jsonl`, delegate to `scanSessionFile`, and push non-null results.
- Parser-specific logic (event mapping, `endedOnError`, `session_meta` handling) is untouched.

**F2 — Delete `isGitRepo`**
- Removed the function from `src/git.ts`.
- `src/report.ts`: replaced `const commits = (await isGitRepo(profile.workdir)) ? attributeCommits(...) : [];` with the direct `attributeCommits(await listCommits(profile.workdir, since), profile.sessions)` — behavior-identical since `listCommits` already returns `[]` on non-repo/failure.
- `tests/git.test.ts`: the "non-repo directory" test now only asserts `listCommits` returns `[]`; the `isGitRepo` assertion and import were removed. Test kept, renamed description slightly ("non-repo directory returns empty").
- Confirmed no other references to `isGitRepo` remain in the codebase.

**F3 — Remove unsafe cast in `src/narrative.ts`**
- Replaced `Object.fromEntries(fields.map((k) => [k, parsed[k]])) as unknown as Narrative` with an explicit object literal built from the already-validated `parsed` fields, keeping the `fields` array + validation loop as-is.

**Nit — Hoist duplicated usage string in `src/cli.ts`**
- Added `const USAGE = "usage: asl report [--since 24h] [--open] [--no-llm] [--out DIR]";` and used it in both call sites (missing `report` positional, and `--since` parse failure).

## Files changed
- `src/connectors/jsonl.ts` (new)
- `src/connectors/claude-code.ts`
- `src/connectors/codex.ts`
- `src/git.ts`
- `src/report.ts`
- `src/narrative.ts`
- `src/cli.ts`
- `tests/git.test.ts`

## Verification

### `bun test`
```
bun test v1.3.13 (bf2e2cec)

tests/narrative.test.ts:
warning: narrative fallback (Error: API 529)
warning: narrative fallback (Error: no JSON object in response)

 44 pass
 0 fail
 142 expect() calls
Ran 44 tests across 10 files. [290.00ms]
```
(143 → 142 `expect()` calls is expected: one `isGitRepo` assertion was removed from the "non-repo directory" test per F2's spec. Same 44 test count, 0 failures. Golden test (`tests/golden.test.ts` against `fixtures/golden`) is included in the 44 and passed unchanged, confirming no behavior drift.)

### `bunx tsc --noEmit`
```
(no output — clean)
```

Both checks match the required baseline (44 pass / 0 fail, clean tsc) with no golden-file changes.
