import type { FactSheet } from "./types";

interface Rule {
  re: RegExp;
  sub: string;
}

const KEYWORD = "(?:api[_-]?key|token|secret|password|passwd)";

const BUILTIN: Rule[] = [
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, sub: "[REDACTED]" },
  { re: /\bsk-[A-Za-z0-9_-]{16,}\b/gi, sub: "[REDACTED]" },        // OpenAI/Anthropic-style keys
  { re: /\bghp_[A-Za-z0-9]{20,}\b/gi, sub: "[REDACTED]" },          // GitHub PAT
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gi, sub: "[REDACTED]" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gi, sub: "[REDACTED]" },  // Slack
  { re: /\bAKIA[0-9A-Z]{16}\b/g, sub: "[REDACTED]" },               // AWS access key id
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g, sub: "[REDACTED]" }, // JWT
  // Bearer must run before the keyword rules: "token = Bearer xyz" would
  // otherwise have "Bearer" consumed as the keyword rule's value, leaving the
  // real token behind.
  { re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, sub: "[REDACTED]" }, // Bearer tokens (any case)
  // Quoted values next (may span lines, may contain escaped quotes); keeps
  // key + quotes so JSON/YAML stay parseable. One rule per quote type because
  // a backreference can't appear inside the escape-aware character class.
  { re: new RegExp(`(\\b${KEYWORD}\\b["']?\\s*[:=]\\s*)"(?:\\\\[\\s\\S]|[^"\\\\])*"`, "gi"), sub: '$1"[REDACTED]"' },
  { re: new RegExp(`(\\b${KEYWORD}\\b["']?\\s*[:=]\\s*)'(?:\\\\[\\s\\S]|[^'\\\\])*'`, "gi"), sub: "$1'[REDACTED]'" },
  // Unquoted fallback; the optional opening quote catches values whose closing
  // quote was truncated (error excerpts are cut at the first line). The
  // lookahead only excludes a value that IS the "[REDACTED]" marker and
  // nothing else (optionally quoted, then a closing quote/whitespace/end) —
  // that's exactly what the quoted rules above (or a prior redact() pass)
  // produce, so re-matching it is a no-op we skip for clarity. If more secret
  // characters are glued onto a "[REDACTED]" prefix (e.g. a truncated log
  // line that literally starts with the marker text), the lookahead does NOT
  // match, so the whole run gets collapsed to "[REDACTED]" too — no tail
  // leaks, and the result is stable under a second redact() pass either way.
  { re: new RegExp(`\\b${KEYWORD}\\b\\s*[:=]\\s*(?!["']?\\[REDACTED\\](?:["']|\\s|$))["']?[^\\s"']{4,}`, "gi"), sub: "[REDACTED]" },
  // Marker cleanup for the quote-glued residual (asl-2u3): the quoted rules keep
  // their closing quote, so a secret tail glued straight onto a keyword's marker
  // (password="[REDACTED]"tail) lands OUTSIDE the quoted value, and the unquoted
  // fallback's lookahead treats the quoted "[REDACTED]" as already-done and
  // skips it — so the tail survives. Scoped to the keyword=value context, this
  // drops a trailing run of secret-alphabet characters glued onto the marker
  // while preserving the marker and its quotes so JSON/YAML stay parseable.
  //
  // Best-effort defense-in-depth, NOT a value parser — known, tested limits:
  //  - The tail class is an allowlist of the base64/token alphabet; it excludes
  //    structural delimiters (" ' { } [ ] : , and whitespace), so it can never
  //    eat a following field in valid JSON/YAML/env/query strings, and it
  //    requires >=1 tail char so it is a no-op on clean output (idempotent).
  //  - It therefore covers token-like tails only: a tail led by an excluded
  //    char (password="[REDACTED]"!x) is left as-is.
  //  - For delimiter-FREE adjacent content it WILL over-redact, because that is
  //    indistinguishable from a leaked tail: password="[REDACTED]"user=bob drops
  //    "user=bob". Acceptable for a redactor — it errs toward masking. A fuller
  //    fix would redact the keyword assignment atomically (see asl follow-up).
  { re: new RegExp(`((?:\\b${KEYWORD}\\b["']?\\s*[:=]\\s*)["']?\\[REDACTED\\]["']?)[A-Za-z0-9._~+/=-]+`, "gi"), sub: "$1" },
];

export function redact(text: string, extraPatterns: string[] = []): string {
  let out = text;
  const extras: Rule[] = extraPatterns.flatMap((p) => {
    try {
      return [{ re: new RegExp(p, "g"), sub: "[REDACTED]" }];
    } catch {
      console.error(`warning: invalid redact pattern skipped: ${p}`);
      return [];
    }
  });
  for (const { re, sub } of [...BUILTIN, ...extras]) out = out.replace(re, sub);
  return out;
}

export function redactFacts(facts: FactSheet, extraPatterns: string[] = []): FactSheet {
  const r = (s: string) => redact(s, extraPatterns);
  return {
    ...facts,
    titles: facts.titles.map(r),
    filesTouched: facts.filesTouched.map(r),
    errors: facts.errors.map(r),
    commits: facts.commits.map(r),
  };
}
