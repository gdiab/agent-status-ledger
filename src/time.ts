// All timestamps in the ledger are ISO-8601 UTC (types.ts contract). Sources
// may carry local offsets (git %aI, connector JSONL), so every timestamp is
// normalized here at the ingest boundary — downstream string comparisons
// depend on it.
export function toUtcIso(ts: string): string | undefined {
  // Date.parse treats zone-less date-times as host-local; report content must
  // not depend on the machine's timezone, so zone-less input is pinned to UTC.
  const zoneless = /T\d{2}:\d{2}/.test(ts) && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(ts);
  const ms = Date.parse(zoneless ? `${ts}Z` : ts);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}
