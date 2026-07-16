// The subprocess seam: one shared shape for every caller that shells out
// (doctor's checks need stdout, email needs stderr from curl, engram needs
// both), so no seam invents its own. Defined here — the lowest-level module
// — and re-exported by email.ts/doctor.ts for back-compat with existing
// imports.
//
// The seam is async (Bun.spawn, not Bun.spawnSync) so a subprocess call
// never blocks the event loop: engram enrichment runs inside buildReport's
// concurrent per-profile pool alongside in-flight LLM fetches, and a
// blocking child would serialize all of it (asl-e2q).
export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}
export type Exec = (argv: string[]) => Promise<ExecResult>;

// Output ceiling for spawned children: output is buffered in memory, so a
// runaway child spraying stdout could OOM the report before the timeout
// fires. Bun.spawn's maxBuffer kills the process once its combined output
// exceeds the cap (verified: SIGTERM, non-zero exit → ok:false). 10MB is
// orders of magnitude above anything a legitimate caller produces (engram's
// JSON, curl's SMTP chatter, launchctl listings).
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

// Real subprocess seam factory. Every Exec the CLI hands out is bounded by a
// timeout so no hung child (stuck keychain prompt, stalled engram binary,
// locked SQLite DB) can block the unattended morning report — the same
// never-hang rule apikey.ts's macKeychainLookup enforces (asl-533) — and by
// an output cap (above). A killed or failed spawn degrades to ok:false;
// callers already treat that as "the thing is unavailable" rather than an
// error to surface.
export function makeSpawnExec(timeoutMs: number, maxOutputBytes: number = MAX_OUTPUT_BYTES): Exec {
  return async (argv) => {
    try {
      const proc = Bun.spawn(argv, {
        stdout: "pipe",
        stderr: "pipe",
        timeout: timeoutMs,
        maxBuffer: maxOutputBytes,
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { ok: exitCode === 0, stdout, stderr };
    } catch (e) {
      return { ok: false, stdout: "", stderr: String(e) };
    }
  };
}
