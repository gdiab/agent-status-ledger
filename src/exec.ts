// Real subprocess seam factory. Every Exec the CLI hands out is bounded by a
// timeout so no hung child (stuck keychain prompt, stalled engram binary,
// locked SQLite DB) can block the unattended morning report — the same
// never-hang rule apikey.ts's macKeychainLookup enforces (asl-533). A killed
// or failed spawn degrades to ok:false; callers already treat that as "the
// thing is unavailable" rather than an error to surface.
import type { Exec } from "./email";

export function makeSpawnExec(timeoutMs: number): Exec {
  return (argv) => {
    try {
      const proc = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
      return { ok: proc.exitCode === 0, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
    } catch (e) {
      return { ok: false, stdout: "", stderr: String(e) };
    }
  };
}
