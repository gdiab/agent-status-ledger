// Optional, fail-soft enrichment via Engram (github.com/clickety-clacks/engram).
// The connector is split into a shared spine (tape.ts: tape reading, CLI
// parsing, shape validation, budgets, the sanitizeTapeText redaction choke
// point) plus one module per pass:
//   - evidence.ts: corroborates claimed_only completions up to
//                  partially_proven (upgradeEvidence / corroborateSessions)
//   - lineage.ts:  dispatch-marker lineage, orchestrator → subagent runs
//                  (findDispatches / discoverDispatchLinks)
//   - dialogue.ts: ONE owned-dialogue walk feeding two pure folds — bead IDs
//                  mentioned in dialogue (for TaskThread grouping) and the
//                  work-vs-think classification plus the awaited question
//                  (findDialogueFacts / discoverDialogueFacts)
// This index re-exports the connector's public surface, so importers keep
// addressing one module: `./connectors/engram`.
export {
  ENGRAM_TIMEOUT_MS,
  sanitizeTapeText,
  type SanitizedTapeText,
  type SessionRef,
  type EngramPassOptions,
} from "./tape";
export { corroborateSessions, upgradeEvidence, type UpgradeResult } from "./evidence";
export {
  discoverDispatchLinks,
  findDispatches,
  type DispatchDiscovery,
  type DispatchLink,
} from "./lineage";
export {
  discoverDialogueFacts,
  findDialogueFacts,
  type ConversationSignal,
  type DialogueFacts,
} from "./dialogue";
