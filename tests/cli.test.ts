import { describe, expect, test } from "bun:test";

const repoRoot = new URL("..", import.meta.url).pathname;

// The CLI validates --layout immediately after parseArgs, before loadConfig or
// any log scanning, so this subprocess test is fast and touches nothing real.
describe("cli", () => {
  test("invalid --layout exits 2 with usage", () => {
    const proc = Bun.spawnSync(["bun", "src/cli.ts", "report", "--layout", "bogus"], { cwd: repoRoot });
    expect(proc.exitCode).toBe(2);
    const err = proc.stderr.toString();
    expect(err).toContain('--layout must be "cards" or "flat"');
    expect(err).toContain("usage:");
  });

  test("--layout with no value exits 2 with usage", () => {
    const proc = Bun.spawnSync(["bun", "src/cli.ts", "report", "--layout"], { cwd: repoRoot });
    expect(proc.exitCode).toBe(2);
    expect(proc.stderr.toString()).toContain("usage:");
  });

  test("usage mentions --no-email", () => {
    const proc = Bun.spawnSync(["bun", "src/cli.ts", "not-a-command"], { cwd: repoRoot });
    expect(proc.exitCode).toBe(2);
    expect(proc.stderr.toString()).toContain("--no-email");
  });
});
