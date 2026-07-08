import type { AgentProfile, CommitEvidence, FactSheet, Narrative, Status } from "./types";

const CAP_FILES = 30;
const CAP_ERRORS = 10;

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

export function templateNarrative(f: FactSheet, status: Status): Narrative {
  const sessions = `${f.sessionCount} session${f.sessionCount === 1 ? "" : "s"}`;
  const topics = f.titles.length ? f.titles.join("; ") : "untitled work";
  return {
    workedOn: `${sessions}: ${topics}.`,
    completed: f.commits.length ? `Commits: ${f.commits.join("; ")}.` : "No durable artifacts detected.",
    inProgress: status === "active" || status === "idle" ? `Last activity ${f.lastActivity}.` : "Nothing in progress.",
    blocked: f.errors.length ? `Errors seen: ${f.errors.join("; ")}.` : "No blockers detected.",
    recommendation:
      status === "failed" || status === "blocked" ? "Investigate the errors above."
      : status === "needs_human" ? "An approval or decision is waiting on you."
      : status === "silent" ? "Check whether this agent is stuck."
      : f.commits.length ? "Review the commits." : "No action needed.",
  };
}

const PROMPT_HEADER = `You write one agent's entry in a morning standup report about AI coding agents.
Use ONLY the facts in the JSON below. Do not invent work, files, or outcomes.
Reply with STRICT JSON, no markdown fences, exactly these string fields:
{"workedOn": "...", "completed": "...", "inProgress": "...", "blocked": "...", "recommendation": "..."}
One or two short sentences per field. If a field has no supporting facts, say so plainly.`;

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
      },
      source: "llm",
    };
  } catch (e) {
    console.error(`warning: narrative fallback (${e})`);
    return fallback;
  }
}
