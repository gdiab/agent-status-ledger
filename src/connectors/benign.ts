// Not every is_error tool_result is a blocker. Agents probe: a no-match grep,
// an ls of a directory that isn't there yet, a harness nudge to re-read a file
// — all healthy exploration. Reporting these as errors inflates the Blocked
// narrative and can flip a productive session to failed (asl-4h6). Rules are
// grounded in a 5-day sample of real is_error results (116 seen, 87 distinct).
//
// The bias is deliberate: fail toward alerting. A benign error we miss is one
// noisy narrative line; a real failure we swallow is a missed morning alert.
// So only unambiguous shapes are benign — anything compound or uncertain
// stays an error.

// Commands whose exit 1 conventionally means "nothing found", not "it broke".
const SEARCHY = new Set(["grep", "rg", "find", "ls", "fd", "which", "test", "[", "stat", "diff", "cmp", "cat", "head", "tail"]);

// Anything that chains or substitutes commands makes the failing segment
// ambiguous ("bun test && rg TODO" exits 1 from the tests, not rg) — never
// benign. Pipes are fine: a pipeline's exit status is its last command's.
const COMPOUND = /&&|\|\||;|\n|\$\(|`/;

export interface ToolUse {
  name: string;
  input: unknown;
}

function bashCommand(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const c = (input as { command?: unknown }).command;
  return typeof c === "string" ? c : "";
}

export function isBenignToolError(tool: ToolUse | undefined, body: string): boolean {
  const b = body.trimStart();
  // Interactive steering: the human declined this call and the session moved on.
  if (b.startsWith("The user doesn't want to proceed")) return true;
  // Harness protocol nudges (unread file, blocked command, input validation):
  // self-corrected on the next turn, never a work blocker.
  if (b.startsWith("<tool_use_error>")) return true;
  // Exploratory read of a file that isn't there.
  if (tool?.name === "Read" && b.startsWith("File does not exist")) return true;
  if (tool?.name === "Bash" && /^Exit code 1\b/.test(b)) {
    const command = bashCommand(tool.input);
    if (!command || COMPOUND.test(command)) return false;
    const words = command.split("|").map((seg) => seg.trim().split(/\s+/, 1)[0] ?? "");
    return words.every((w) => SEARCHY.has(w));
  }
  return false;
}
