// The subprocess seam: one shared shape for every caller that shells out
// (doctor's checks need stdout, email needs stderr from curl, engram needs
// both), so no seam invents its own. Defined here — the lowest-level module
// — and re-exported by email.ts/doctor.ts for back-compat with existing
// imports.
export type Exec = (argv: string[]) => { ok: boolean; stdout: string; stderr: string };

// Output ceiling for spawned children: spawnSync buffers all output in
// memory, so a runaway child spraying stdout could OOM the report before
// the timeout fires. Bun.spawnSync's maxBuffer kills the process once its
// combined output exceeds the cap (verified: exitCode null / SIGTERM →
// ok:false). 10MB is orders of magnitude above anything a legitimate
// caller produces (engram's JSON, curl's SMTP chatter, launchctl listings).
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

// Real subprocess seam factory. Every Exec the CLI hands out is bounded by a
// timeout so no hung child (stuck keychain prompt, stalled engram binary,
// locked SQLite DB) can block the unattended morning report — the same
// never-hang rule apikey.ts's macKeychainLookup enforces (asl-533) — and by
// an output cap (above). A killed or failed spawn degrades to ok:false;
// callers already treat that as "the thing is unavailable" rather than an
// error to surface.
export function makeSpawnExec(timeoutMs: number, maxOutputBytes: number = MAX_OUTPUT_BYTES): Exec {
  return (argv) => {
    try {
      const proc = Bun.spawnSync(argv, {
        stdout: "pipe",
        stderr: "pipe",
        timeout: timeoutMs,
        maxBuffer: maxOutputBytes,
      });
      return { ok: proc.exitCode === 0, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
    } catch (e) {
      return { ok: false, stdout: "", stderr: String(e) };
    }
  };
}
