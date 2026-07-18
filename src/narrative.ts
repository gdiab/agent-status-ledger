import type { AgentEvent, AgentProfile, CommitEvidence, FactSheet, Narrative, Status } from "./types";
import { capSanitizedText, sanitizeTapeText } from "./redact";

const CAP_FILES = 30;
const CAP_ERRORS = 10;

// ── Event-derived narrative signal (asl-yko) ────────────────────────────────
//
// The base FactSheet discards session events, so agents whose work never
// lands in titles/files/errors/commits (Codex review sessions today: the
// whole verdict lives in task_complete's last_agent_message) produce
// factless prompts. NarrativeFacts is the NARRATIVE INPUT superset: it feeds
// generateNarrative only — AgentReport.facts stays a plain FactSheet, so the
// report JSON and the --no-llm template path are byte-identical to before.
export interface NarrativeFacts extends FactSheet {
  // The agent's own final message per session ("what did it conclude"),
  // newest session first. Self-reported conclusions, not verified outcomes.
  sessionOutcomes?: string[];
  // Bounded selection of notable events: failures first, then content-
  // bearing task/run boundaries, then recent activity — newest first within
  // each tier.
  eventHighlights?: string[];
}

// Hard caps on the event signal, chosen so a many-session profile can never
// blow up the prompt: worst case is OUTCOMES_MAX * OUTCOME_LINE_MAX +
// EVENT_LINES_MAX * EVENT_LINE_MAX = 5*400 + 12*200 = 4.4 KB (~1.1k tokens)
// of event text per profile, regardless of session or event count.
const OUTCOMES_MAX = 5;       // newest sessions whose final message is quoted
const OUTCOME_LINE_MAX = 400; // per outcome line, ellipsis included — connectors clip at 200 today; belt and braces for future ones
const EVENT_LINES_MAX = 12;   // total highlight lines per profile
const EVENT_LINE_MAX = 200;   // per highlight line, ellipsis included — matches the connector clip LINE_MAX

// Content-free summaries carry no signal for the LLM: connector boilerplate
// ("session started", "user turn") and bare event-type tokens the codex
// connector emits verbatim ("task_started", "agent_message"). "task complete"
// is the codex fallback when last_agent_message is absent.
const CONTENT_FREE = new Set(["session started", "task complete", "user turn", "assistant turn"]);
// Closed set of bare event-type tokens connectors emit verbatim as the whole
// summary. Deliberately NOT a snake_case pattern: legitimate content can be
// exactly one snake_case token (a verdict like "request_changes", a status
// like "needs_human"), and dropping a session's true last completion would
// silently promote an earlier one to sessionOutcome. Deletable stopgap, same
// as CONTENT_FREE: goes away once connectors stop emitting type names.
const TYPE_NAME_TOKENS = new Set(["task_started", "agent_message", "user_message", "task_complete"]);
const hasContent = (summary: string): boolean =>
  !CONTENT_FREE.has(summary) && !TYPE_NAME_TOKENS.has(summary);

// One choke point for every event-derived line: connector-level redaction
// (makeClip) already ran, but the line is re-sanitized and re-capped here so
// no connector change can widen what reaches the prompt. capSanitizedText's
// contract: output ≤ max INCLUDING the ellipsis, never cutting through a
// surrogate pair or a [REDACTED] marker.
const toLine = (raw: string, max: number, redactPatterns: string[]): string =>
  capSanitizedText(sanitizeTapeText(raw, redactPatterns), max);

// Enrich a built factsheet with bounded event signal for the LLM prompt.
// Pure selection over profile.sessions; the base sheet passes through
// untouched. Empty selections stay absent so factless profiles serialize
// exactly as before.
export function buildNarrativeFacts(facts: FactSheet, profile: AgentProfile, redactPatterns: string[]): NarrativeFacts {
  // Outcomes: per session, the LAST content-bearing completion message —
  // newest sessions first (sessions are sorted ascending), capped.
  // Exclusion keys are values (type+summary), not object identities, so the
  // invariant survives events being cloned anywhere upstream.
  const eventKey = (e: AgentEvent) => `${e.type}\n${e.summary}`;
  const outcomeKeys = new Set<string>();
  const sessionOutcomes: string[] = [];
  for (const session of [...profile.sessions].reverse()) {
    if (sessionOutcomes.length >= OUTCOMES_MAX) break;
    const last = [...session.events].reverse().find((e) => e.type === "completed" && hasContent(e.summary));
    if (!last) continue;
    outcomeKeys.add(eventKey(last));
    sessionOutcomes.push(toLine(`${last.timestamp} ${last.summary}`, OUTCOME_LINE_MAX, redactPatterns));
  }

  // Highlights: three priority tiers over all content-bearing events not
  // already quoted as an outcome — failures, then task/run boundaries, then
  // recent activity — newest first within each tier, deduped on the
  // type+sanitized summary so a repeating error (or distinct secrets that
  // all sanitize to the same [REDACTED] line) doesn't crowd out the rest.
  const BOUNDARY = new Set(["completed", "run_started", "approval_requested", "blocked", "artifact_created"]);
  const tier = (e: AgentEvent) => (e.type === "failed" ? 0 : BOUNDARY.has(e.type) ? 1 : 2);
  const candidates = profile.sessions
    .flatMap((s) => s.events)
    .filter((e) => hasContent(e.summary) && !outcomeKeys.has(eventKey(e)))
    .sort((a, b) => tier(a) - tier(b) || b.timestamp.localeCompare(a.timestamp));
  const seen = new Set<string>();
  const eventHighlights: string[] = [];
  for (const e of candidates) {
    if (eventHighlights.length >= EVENT_LINES_MAX) break;
    const key = `${e.type}\n${toLine(e.summary, EVENT_LINE_MAX, redactPatterns)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    eventHighlights.push(toLine(`${e.timestamp} ${e.type}: ${e.summary}`, EVENT_LINE_MAX, redactPatterns));
  }

  return {
    ...facts,
    ...(sessionOutcomes.length ? { sessionOutcomes } : {}),
    ...(eventHighlights.length ? { eventHighlights } : {}),
  };
}

// Per-status closing copy: standup speaks as the agent, recommendation to the human.
// One table so a new Status gets both voices in one place.
const STATUS_VOICE: Partial<Record<Status, { standup: string; recommendation: string }>> = {
  needs_human: { standup: "I'm waiting on you for an approval or decision.", recommendation: "An approval or decision is waiting on you." },
  blocked: { standup: "I'm stuck and need help.", recommendation: "Investigate the errors above." },
  failed: { standup: "I'm stuck and need help.", recommendation: "Investigate the errors above." },
  silent: { standup: "I've gone quiet — check on me.", recommendation: "Check whether this agent is stuck." },
};

export function buildFactSheet(profile: AgentProfile, commits: CommitEvidence[]): FactSheet {
  const titles = [...new Set(profile.sessions.map((s) => s.title).filter((t): t is string => !!t))];
  const filesTouched = [...new Set(profile.sessions.flatMap((s) => s.filesTouched))].sort().slice(0, CAP_FILES);
  const errors = [...new Set(profile.sessions.flatMap((s) => s.errors))].slice(0, CAP_ERRORS);
  const attributed = commits.filter((c) => c.attributed).map((c) => `${c.sha.slice(0, 7)} ${c.subject}`);
  return {
    titles,
    filesTouched,
    errors,
    commits: attributed,
    sessionCount: profile.sessions.length,
    firstActivity: profile.sessions.reduce((min, s) => (!min || s.startedAt < min ? s.startedAt : min), ""),
    lastActivity: profile.sessions.reduce((max, s) => (s.lastEventAt > max ? s.lastEventAt : max), ""),
  };
}

// Exact filler strings templateNarrative emits when a field has nothing to
// say. Renderers that collapse no-content rows must anchor to these constants
// (combined with empty backing facts), never free-text matching — LLM
// narratives vary and must never be sniffed.
export const FILLER_COMPLETED = "No durable artifacts detected.";
export const FILLER_IN_PROGRESS = "Nothing in progress.";
export const FILLER_BLOCKED = "No blockers detected.";
export const FILLER_RECOMMENDATION = "No action needed.";

export function templateNarrative(f: FactSheet, status: Status): Narrative {
  const sessions = `${f.sessionCount} session${f.sessionCount === 1 ? "" : "s"}`;
  const topics = f.titles.length ? f.titles.join("; ") : "untitled work";
  const voice = STATUS_VOICE[status];
  const standup =
    `I worked on ${topics} across ${sessions}.` +
    (f.commits.length ? ` I landed ${f.commits.length} commit${f.commits.length === 1 ? "" : "s"}.` : "") +
    (f.errors.length ? ` I hit ${f.errors.length} error${f.errors.length === 1 ? "" : "s"} along the way.` : "") +
    (voice ? ` ${voice.standup}` : " Nothing is blocking me.");
  return {
    workedOn: `${sessions}: ${topics}.`,
    completed: f.commits.length ? `Commits: ${f.commits.join("; ")}.` : FILLER_COMPLETED,
    inProgress: status === "active" || status === "idle" ? `Last activity ${f.lastActivity}.` : FILLER_IN_PROGRESS,
    blocked: f.errors.length ? `Errors seen: ${f.errors.join("; ")}.` : FILLER_BLOCKED,
    recommendation: voice?.recommendation ?? (f.commits.length ? "Review the commits." : FILLER_RECOMMENDATION),
    standup,
  };
}

const PROMPT_HEADER = `You write one agent's entry in a morning standup report about AI coding agents.
Use ONLY the facts in the JSON below. Do not invent work, files, or outcomes.
Reply with STRICT JSON, no markdown fences, exactly these string fields:
{"workedOn": "...", "completed": "...", "inProgress": "...", "blocked": "...", "recommendation": "...", "standup": "..."}
One or two short sentences per field, except "standup": 2-4 short sentences, first person singular,
written as the agent itself speaking at standup ("I ..."), under 400 characters, grounded in the same
facts, mentioning the blocker if one exists. If a field has no supporting facts, say so plainly.
"sessionOutcomes", when present, are the agent's own final messages per session (newest first) —
report them as what the agent concluded or delivered, not as independently verified outcomes.
"eventHighlights", when present, are notable run events (failures first). Lines in either list may
be truncated ("…"); each starts with its UTC timestamp.`;

function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object in response");
  return text.slice(start, end + 1);
}

export async function generateNarrative(
  facts: NarrativeFacts,
  status: Status,
  opts: { model: string; apiKey?: string; fetchFn?: typeof fetch },
): Promise<{ narrative: Narrative; source: "llm" | "template" }> {
  const fallback = { narrative: templateNarrative(facts, status), source: "template" as const };
  if (!opts.apiKey) return fallback;
  try {
    const fetchFn = opts.fetchFn ?? fetch;
    const res = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": opts.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: 1024,
        messages: [{ role: "user", content: `${PROMPT_HEADER}\n\nStatus: ${status}\nFacts:\n${JSON.stringify(facts, null, 2)}` }],
      }),
    });
    if (!res.ok) throw new Error(`API ${res.status}`);
    const data: any = await res.json();
    const text: string = data.content?.[0]?.text ?? "";
    const parsed = JSON.parse(extractJson(text));
    const fields = ["workedOn", "completed", "inProgress", "blocked", "recommendation"] as const;
    for (const k of fields) {
      if (typeof parsed[k] !== "string") throw new Error(`missing field ${k}`);
    }
    return {
      narrative: {
        workedOn: parsed.workedOn,
        completed: parsed.completed,
        inProgress: parsed.inProgress,
        blocked: parsed.blocked,
        recommendation: parsed.recommendation,
        // Deliberate asymmetry: the five fields above are all-or-nothing (any
        // missing → whole narrative falls back), but standup alone may be
        // template-filled — so source "llm" means "at most this one field is
        // template", not "every field came from the model".
        standup: typeof parsed.standup === "string" && parsed.standup.trim()
          ? parsed.standup
          : fallback.narrative.standup,
      },
      source: "llm",
    };
  } catch (e) {
    console.error(`warning: narrative fallback (${e})`);
    return fallback;
  }
}
