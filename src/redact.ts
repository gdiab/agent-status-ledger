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
  // lookahead stops it re-mangling the quoted rules' own "[REDACTED]" output.
  { re: new RegExp(`\\b${KEYWORD}\\b\\s*[:=]\\s*["']?(?!\\[REDACTED\\])[^\\s"']{4,}`, "gi"), sub: "[REDACTED]" },
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
