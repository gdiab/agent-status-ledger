// Optional, fail-soft enrichment via Engram (github.com/clickety-clacks/engram):
// fingerprint-corroborates a claimed_only completion claim against a real code
// edit, upgrading evidence to partially_proven when a real match exists.
// Never a hard dependency — every function here returns a "no match"/failure
// value instead of throwing, mirroring email.ts's never-throws contract.
import type { CheckResult } from "../doctor";
import type { Exec } from "../email";

export type { Exec };

// Engram's own echoed min_confidence (0.5) is not strictly enforced by the
// CLI itself — sessions well below it have been observed in real result
// sets. This is ASL's own independent floor, applied on top of whatever the
// CLI returns.
const MIN_CONFIDENCE = 0.5;

export function checkEngramAvailable(binaryPath: string, exec: Exec): CheckResult {
  const name = "engram binary";
  const r = exec([binaryPath, "--help"]);
  return r.ok
    ? { name, ok: true, detail: `found via ${binaryPath}` }
    : {
        name,
        ok: false,
        detail: `${binaryPath} --help failed`,
        fix: `build engram from source (cargo build --release in the engram repo) and set connectors.engram.binary_path in ~/.config/asl/config.toml to the absolute binary path`,
      };
}

interface ExplainSession {
  session_id?: unknown;
  confidence?: unknown;
  timestamp?: unknown;
  files_touched?: unknown;
}

interface ExplainResult {
  matched: boolean;
  citation?: string;
}

// `engram explain <file>` prints two lines of config/db path info before the
// JSON payload; scan backwards for the last line that looks like a JSON
// object rather than assuming an exact prefix line count.
function extractJsonLine(stdout: string): string | undefined {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line.startsWith("{")) return line;
  }
  return undefined;
}

// Queries Engram for provenance on a single file (bare path, no line range —
// see explanation at the report.ts call site) and decides, independently of
// the CLI's own echoed confidence/error handling, whether that constitutes a
// real fingerprint match for `filePath`. Never throws.
export async function upgradeEvidence(
  filePath: string,
  binaryPath: string,
  exec: Exec,
): Promise<ExplainResult> {
  try {
    const r = exec([binaryPath, "explain", filePath]);
    if (!r.ok) return { matched: false };

    const jsonLine = extractJsonLine(r.stdout);
    if (!jsonLine) return { matched: false };

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonLine);
    } catch {
      return { matched: false };
    }
    if (typeof parsed !== "object" || parsed === null) return { matched: false };
    const obj = parsed as Record<string, unknown>;
    if ("error" in obj) return { matched: false };

    const sessions = Array.isArray(obj.sessions) ? (obj.sessions as ExplainSession[]) : [];
    for (const s of sessions) {
      const confidence = typeof s.confidence === "number" ? s.confidence : undefined;
      const filesTouched = Array.isArray(s.files_touched) ? (s.files_touched as unknown[]) : [];
      if (confidence !== undefined && confidence >= MIN_CONFIDENCE && filesTouched.includes(filePath)) {
        const sessionId = typeof s.session_id === "string" ? s.session_id : "unknown session";
        const timestamp = typeof s.timestamp === "string" ? s.timestamp : "unknown time";
        return {
          matched: true,
          citation: `engram session ${sessionId} (${timestamp}, confidence ${confidence})`,
        };
      }
    }
    return { matched: false };
  } catch {
    return { matched: false };
  }
}
