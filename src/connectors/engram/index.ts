// Optional, fail-soft enrichment via Engram (github.com/clickety-clacks/engram).
// The connector is split into a shared spine (tape.ts: tape reading, CLI
// parsing, shape validation, budgets, the sanitizeTapeText redaction choke
// point) plus one module per pass:
//   - evidence.ts:  corroborates claimed_only completions up to
//                   partially_proven (upgradeEvidence / corroborateSessions)
//   - lineage.ts:   dispatch-marker lineage, orchestrator → subagent runs
//                   (findDispatches / discoverDispatchLinks)
//   - task-keys.ts: bead IDs mentioned in dialogue, for TaskThread grouping
//                   (findTaskKeys / discoverTaskKeys)
//   - signals.ts:   work-vs-think classification and the awaited question
//                   (findConversationSignal / discoverConversationSignals)
// This index re-exports the connector's public surface, so importers keep
// addressing one module: `./connectors/engram`.
export {
  ENGRAM_TIMEOUT_MS,
  sanitizeTapeText,
  type SanitizedTapeText,
  type LineageSession,
  type CorroborateOptions,
} from "./tape";
export { corroborateSessions, upgradeEvidence, type UpgradeResult } from "./evidence";
export {
  discoverDispatchLinks,
  findDispatches,
  type DispatchDiscovery,
  type DispatchLink,
} from "./lineage";
export { discoverTaskKeys, findTaskKeys } from "./task-keys";
export {
  discoverConversationSignals,
  findConversationSignal,
  type ConversationSignal,
} from "./signals";
