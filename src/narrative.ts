import type { AgentProfile, CommitEvidence, FactSheet, Narrative, Status } from "./types";

const CAP_FILES = 30;
const CAP_ERRORS = 10;

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
facts, mentioning the blocker if one exists. If a field has no supporting facts, say so plainly.`;

function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object in response");
  return text.slice(start, end + 1);
}

export async function generateNarrative(
  facts: FactSheet,
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
