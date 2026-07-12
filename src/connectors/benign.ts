// Not every is_error tool_result is a blocker. Agents probe: a no-match grep,
// an ls of a directory that isn't there yet, a harness nudge to re-read a file
// — all healthy exploration. Reporting these as errors inflates the Blocked
// narrative and can flip a productive session to failed (asl-4h6). Rules are
// grounded in a 5-day sample of real is_error results (116 seen, 87 distinct).

// Commands whose exit 1 conventionally means "nothing found", not "it broke".
const SEARCHY = new Set(["grep", "rg", "find", "ls", "fd", "which", "test", "[", "stat", "diff", "cmp"]);

// Exit-1 bodies that say "the thing you looked for isn't there".
const NOT_FOUND = /No such file or directory|no matches found/i;

// First word of each command position in a (possibly compound) shell string —
// "cd x && grep -rn foo | head" → cd, grep, head. Matching anywhere in the
// string would misfire on arguments ("bun test" is not the test builtin).
function commandWords(command: string): string[] {
  return command
    .split(/\|\||&&|;|\||\n|\$\(/)
    .map((seg) => seg.trim().split(/\s+/, 1)[0] ?? "")
    .filter(Boolean);
}

export function isBenignToolError(toolName: string, input: unknown, body: string): boolean {
  const b = body.trimStart();
  // Interactive steering: the human declined this call and the session moved on.
  if (b.startsWith("The user doesn't want to proceed")) return true;
  // Harness protocol nudges (unread file, blocked command, input validation):
  // self-corrected on the next turn, never a work blocker.
  if (b.startsWith("<tool_use_error>")) return true;
  // Exploratory read of a file that isn't there.
  if (toolName === "Read" && b.startsWith("File does not exist")) return true;
  if (toolName === "Bash" && /^Exit code 1\b/.test(b)) {
    if (NOT_FOUND.test(b)) return true;
    const command = typeof (input as any)?.command === "string" ? (input as any).command : "";
    if (commandWords(command).some((w) => SEARCHY.has(w))) return true;
  }
  return false;
}
