import type { FactSheet } from "./types";

const BUILTIN: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,                                  // OpenAI/Anthropic-style keys
  /\bghp_[A-Za-z0-9]{20,}\b/g,                                    // GitHub PAT
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,                            // Slack
  /\bAKIA[0-9A-Z]{16}\b/g,                                        // AWS access key id
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g, // JWT
  /\b(api[_-]?key|token|secret|password|passwd)\b\s*[:=]\s*["']?[^\s"']{8,}/gi,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g,                         // Bearer tokens
];

export function redact(text: string, extraPatterns: string[] = []): string {
  let out = text;
  const extras = extraPatterns.flatMap((p) => {
    try {
      return [new RegExp(p, "g")];
    } catch {
      console.error(`warning: invalid redact pattern skipped: ${p}`);
      return [];
    }
  });
  for (const re of [...BUILTIN, ...extras]) out = out.replace(re, "[REDACTED]");
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
