import { describe, expect, test } from "bun:test";

// The CLI validates --layout immediately after parseArgs, before loadConfig or
// any log scanning, so this subprocess test is fast and touches nothing real.
describe("cli", () => {
  test("invalid --layout exits 2 with usage", () => {
    const proc = Bun.spawnSync(["bun", "src/cli.ts", "report", "--layout", "bogus"]);
    expect(proc.exitCode).toBe(2);
    const err = proc.stderr.toString();
    expect(err).toContain('--layout must be "cards" or "flat"');
    expect(err).toContain("usage:");
  });
});
