import { describe, expect, test } from "bun:test";
import { makeSpawnExec } from "../src/exec";

describe("makeSpawnExec", () => {
  test("runs a real command and captures stdout", () => {
    const exec = makeSpawnExec(5_000);
    const r = exec(["/bin/echo", "hi"]);
    expect(r.ok).toBe(true);
    expect(r.stdout.trim()).toBe("hi");
  });

  test("captures stderr and reports ok:false on non-zero exit", () => {
    const exec = makeSpawnExec(5_000);
    const r = exec(["/bin/ls", "/no/such/dir/anywhere-xyz"]);
    expect(r.ok).toBe(false);
    expect(r.stderr.length).toBeGreaterThan(0);
  });

  test("a command exceeding the timeout degrades to ok:false instead of hanging", () => {
    const exec = makeSpawnExec(250);
    const started = Date.now();
    const r = exec(["/bin/sleep", "10"]);
    const elapsed = Date.now() - started;
    expect(r.ok).toBe(false);
    expect(elapsed).toBeLessThan(5_000); // killed by the timeout, not by sleep finishing
  });

  test("a missing binary degrades to ok:false instead of throwing", () => {
    const exec = makeSpawnExec(5_000);
    const r = exec(["/no/such/binary-xyz"]);
    expect(r.ok).toBe(false);
  });
});
