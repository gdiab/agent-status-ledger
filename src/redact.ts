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

// ── Tape-sourced text: the sanitizeTapeText choke point (asl-a5v) ───────────
//
// These live HERE, not in the engram connector, because the report model
// (src/types.ts) declares tape-quoting fields as SanitizedTapeText: typing
// AgentReport.evidenceCitation/awaitingQuestion with a connector-owned brand
// would point the base model at a connector module — the dependency
// inversion the asl-a5v review flagged as the signal that the brand and its
// producer belong in src/redact.ts, the lowest-level redaction module. The
// engram spine (src/connectors/engram/tape.ts) re-exports both, so the
// connector's public surface is unchanged. (types.ts ↔ redact.ts import
// each other type-only; both edges erase at compile time, so there is no
// runtime cycle.)
//
// Tape-sourced strings end up in every consumer surface (JSON, markdown,
// html, digest, email) and are assembled from engram-reported content
// (file paths and quoted DIALOGUE), which is untrusted AND unredacted —
// engram stores verbatim transcripts. Neutralize at ingestion — control
// chars (incl. newlines, which would let "#"/markdown structures start a
// line), DEL, angle brackets, and Unicode format characters (\p{Cf}:
// zero-width space/joiners, word joiner, BOM, soft hyphen, bidi controls —
// all invisible in renderers, so a secret split by one would reconstruct on
// copy-paste and bidi controls could reorder the rendered display) are
// stripped so the text is inert before it reaches any renderer. This
// deliberately does not depend on renderer-side escaping (asl-xis).
//
// \p{Cf} alone is not enough: Unicode's Default_Ignorable_Code_Point
// property (DerivedCoreProperties.txt) also contains characters in other
// general categories that render as nothing — notably COMBINING GRAPHEME
// JOINER U+034F and the variation selectors U+FE00–FE0F / U+E0100–E01EF,
// which are nonspacing marks (\p{Mn}) — so they too can invisibly split a
// secret that reconstructs on copy-paste. JS regex cannot express
// \p{Default_Ignorable_Code_Point} directly, so the non-Cf members are
// enumerated explicitly below (do NOT widen to all of \p{Mn}: legitimate
// combining marks are load-bearing in NFD file paths, e.g. "café.ts" from
// macOS filesystems):
//   U+034F        COMBINING GRAPHEME JOINER (Mn)
//   U+115F..1160  HANGUL CHOSEONG/JUNGSEONG FILLER (Lo)
//   U+17B4..17B5  KHMER VOWEL INHERENT AQ/AA (Mn)
//   U+180B..180F  MONGOLIAN FREE VARIATION SELECTORS + VOWEL SEPARATOR
//   U+2065        reserved, default-ignorable (Cn)
//   U+3164        HANGUL FILLER (Lo)
//   U+FE00..FE0F  VARIATION SELECTOR-1..16 (Mn)
//   U+FFA0        HALFWIDTH HANGUL FILLER (Lo)
//   U+FFF0..FFF8  reserved, default-ignorable (Cn)
//   U+E0000..E0FFF plane-14 tags + VARIATION SELECTOR-17..256 + reserved
//
// Known fidelity tradeoff (accepted, security over fidelity): several
// stripped code points are legal, potentially load-bearing filename
// characters — SOFT HYPHEN U+00AD (a citation for "/repo/co­operate.ts"
// comes out naming "/repo/cooperate.ts", a different file), variation
// selectors (which can change glyph/semantic identity of the preceding
// character), Mongolian FVS, Khmer inherent vowels, and Hangul fillers.
// A stripped citation can therefore name a path that differs from the one
// actually edited. We accept the mislabeled citation rather than let an
// invisible or rendering-altering character through the boundary.
const TAPE_UNSAFE =
  /[\x00-\x1f\x7f<>]|\p{Cf}|[\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u2065\u3164\uFE00-\uFE0F\uFFA0\uFFF0-\uFFF8]|[\u{E0000}-\u{E0FFF}]/gu;

// Branded string marking a tape-sourced value that went through
// sanitizeTapeText. This is a compile-time convention against ACCIDENTAL
// misuse, not a proof: the brand can be forged with an assertion / `any` /
// JSON.parse. What it buys: sanitizeTapeText below is the single sanctioned
// producer, and the report fields that quote tape content
// (AgentReport.evidenceCitation, AgentReport.awaitingQuestion) declare this
// type, so the compiler flags any code path that forgot the choke point —
// as long as nobody casts around it.
declare const sanitizedTape: unique symbol;
export type SanitizedTapeText = string & { readonly [sanitizedTape]: true };

// THE redaction choke point for the Engram boundary (asl-a5v): every string
// that originates in engram subprocess output must pass through here at the
// point it is parsed into an ASL data structure — never at render time, so
// no future render path can bypass it. Composes the shared secret-matching
// rules above (builtin + user extraPatterns — no new matching logic, per
// asl-2u3) with the tape-specific structural hardening of TAPE_UNSAFE.
// Redact runs on BOTH sides of the strip, because each order has an
// inverse evasion:
//  - strip-then-redact only: a boundary-dependent rule that matched the raw
//    text stops matching once the strip glues adjacent chars onto the secret
//    ("AKIA…F\x00X" → "AKIA…FX" breaks the \b…{16}\b rule);
//  - redact-then-strip only: a secret split by a stripped char slips past
//    the redactor as short fragments and is glued back into a live key
//    ("sk-fix\x00ture…" reassembles).
// Running redact → strip → redact covers both representations. Cost: redact
// runs twice per tape string — quoted strings are one-liners and redact is a
// fixed list of regex passes, so this is noise next to the subprocess calls.
//
// extraPatterns is deliberately required (no default): a defaulted [] let
// call sites silently drop the user's redactPatterns while still receiving
// branded output. Passing [] must be a visible choice at the call site.
//
// Known cosmetic limitation (accepted): double-redact is not idempotent for
// pathological extraPatterns that match the marker itself — e.g. ["REDACTED"]
// or ["\\]"] mutate the first pass's [REDACTED] markers into noise like
// [[[REDACTED]]]. No secret survives (pinned by test); only the marker text
// gets mangled. The obvious fix — second pass splits on existing [REDACTED]
// markers and redacts only the non-marker segments — was tried and rejected:
// it blinds the second pass to marker-adjacent context, which demonstrably
// breaks the glued-tail cleanup when the strip glues a secret tail onto a
// quoted marker (password="[REDACTED]"<ZWSP>xyz → the tail xyz survives
// under the split, but is caught by the full-string pass). A cosmetic
// defect does not warrant weakening a real redaction path.
export function sanitizeTapeText(s: string, extraPatterns: string[]): SanitizedTapeText {
  const preStripped = redact(s, extraPatterns);
  return redact(preStripped.replace(TAPE_UNSAFE, ""), extraPatterns) as SanitizedTapeText;
}

// What redact()/sanitizeTapeText substitute for a matched secret. A length
// cap must never cut through an occurrence: a split "[REDA…" reads as
// garbage and could be mistaken for leaked content.
export const REDACTION_MARKER = "[REDACTED]";

// Cut an over-cap sanitized string at a SAFE boundary before appending the
// ellipsis: never through a surrogate pair (a split non-BMP char renders as
// U+FFFD garbage) and never through a REDACTION_MARKER — in both cases the
// cut backs off to before the atom. Marker characters are ASCII, so the
// marker back-off can never re-create a surrogate split. The cap is a hard
// bound on the OUTPUT, ellipsis included — a "140-char cap" surface never
// emits 141. The one truncator for sanitized tape text; per-surface policy
// caps live at the call sites (dialogue.ts's QUESTION_MAX_CHARS, digest.ts's
// AWAITING_QUESTION_MAX).
export function capSanitizedText(s: SanitizedTapeText, max: number): SanitizedTapeText {
  if (s.length <= max) return s;
  let cut = max - 1;
  const hi = s.charCodeAt(cut - 1);
  const lo = s.charCodeAt(cut);
  if (hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff) cut--;
  const markerStart = s.lastIndexOf(REDACTION_MARKER, cut - 1);
  if (markerStart !== -1 && cut > markerStart && cut < markerStart + REDACTION_MARKER.length) {
    cut = markerStart;
  }
  return `${s.slice(0, cut).trimEnd()}…` as SanitizedTapeText;
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
