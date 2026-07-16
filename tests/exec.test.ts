import { describe, expect, test } from "bun:test";
import { makeSpawnExec } from "../src/exec";

describe("makeSpawnExec", () => {
  test("runs a real command and captures stdout", async () => {
    const exec = makeSpawnExec(5_000);
    const r = await exec(["/bin/echo", "hi"]);
    expect(r.ok).toBe(true);
    expect(r.stdout.trim()).toBe("hi");
  });

  test("captures stderr and reports ok:false on non-zero exit", async () => {
    const exec = makeSpawnExec(5_000);
    const r = await exec(["/bin/ls", "/no/such/dir/anywhere-xyz"]);
    expect(r.ok).toBe(false);
    expect(r.stderr.length).toBeGreaterThan(0);
  });

  test("a command exceeding the timeout degrades to ok:false instead of hanging", async () => {
    const exec = makeSpawnExec(250);
    const started = Date.now();
    const r = await exec(["/bin/sleep", "10"]);
    const elapsed = Date.now() - started;
    expect(r.ok).toBe(false);
    expect(elapsed).toBeLessThan(5_000); // killed by the timeout, not by sleep finishing
  });

  test("a missing binary degrades to ok:false instead of throwing", async () => {
    const exec = makeSpawnExec(5_000);
    const r = await exec(["/no/such/binary-xyz"]);
    expect(r.ok).toBe(false);
  });

  test("a runaway process exceeding the output cap is killed and degrades to ok:false", async () => {
    // 64KB cap for the test; production default is MAX_OUTPUT_BYTES.
    const exec = makeSpawnExec(5_000, 64 * 1024);
    const started = Date.now();
    const r = await exec(["yes"]); // emits output forever
    expect(r.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(4_000); // killed by the cap, not the timeout
    // buffered output is bounded near the cap, not unbounded
    expect(r.stdout.length).toBeLessThan(10 * 1024 * 1024);
  });

  test("a slow child does not block the event loop while it runs", async () => {
    // The core asl-e2q property: with the old Bun.spawnSync seam, timers and
    // other promises starved for the child's whole lifetime. Here a timer
    // scheduled AFTER the exec call starts must fire long before the 300ms
    // child exits.
    const exec = makeSpawnExec(5_000);
    const pending = exec(["/bin/sleep", "0.3"]);
    const timerFiredAfterMs = await new Promise<number>((resolve) => {
      const started = Date.now();
      setTimeout(() => resolve(Date.now() - started), 10);
    });
    expect(timerFiredAfterMs).toBeLessThan(250); // fired mid-child, not after it
    expect((await pending).ok).toBe(true);
  });
});
