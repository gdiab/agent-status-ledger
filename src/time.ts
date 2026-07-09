// All timestamps in the ledger are ISO-8601 UTC (types.ts contract). Sources
// may carry local offsets (git %aI, connector JSONL), so every timestamp is
// normalized here at the ingest boundary — downstream string comparisons
// depend on it.
export function toUtcIso(ts: string): string | undefined {
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}
