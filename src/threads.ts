import { basename } from "node:path";
import type { AgentProfile, AgentReport, EvidenceLevel, RawSession, TaskThread, ThreadSession } from "./types";
import { STATUS_RANK } from "./render/rollup";
import { attributeCommits } from "./git";
import { redact } from "./redact";

// TaskThread derivation (PRD §7, asl-1wm): stitch the report's runs into
// task-level narratives at report time — a pure function of data the report
// already holds (consistent with ADR 0002's stateless scan; nothing here is
// ingested or persisted). Two key sources, in preference order:
//   1. bead IDs mentioned in dialogue — supplied by the caller from the
//      engram task-key pass (src/connectors/engram.ts, discoverTaskKeys);
//      an empty map (engram disabled or failing) simply yields no bead
//      threads, never an error;
//   2. file clusters — sessions whose filesTouched overlap, derived from
//      already-parsed session data alone, so grouping survives with engram
//      entirely absent.
// Derivation runs over the POST-filter profile set (only profiles that
// produced a card), the same invariant as dispatch lineage: a thread never
// names a session whose profile was filtered as trivial. Sessions matching
// no thread are simply not in one — their cards are untouched.

// A single-session "thread" restates the profile card and adds nothing;
// threads exist to stitch runs together, so membership starts at two.
const MIN_THREAD_SESSIONS = 2;
// File-cluster edge threshold: one shared file is weak evidence (hub files
// like a project's main module recur across unrelated tasks); two distinct
// shared files is the heuristic's floor for "the same cluster of files".
const MIN_SHARED_FILES = 2;
// File-cluster titles cap the basenames named, like MAX_CITED_FILES keeps
// evidence citations one-liners.
const MAX_TITLE_FILES = 2;

// Strongest-first, mirroring STATUS_RANK's worst-first: a thread reports the
// best proof any member produced (PRD §7: "the strongest evidence any member
// run produced"). Exhaustive by construction, like STATUS_RANK.
const EVIDENCE_RANK: Record<EvidenceLevel, number> = {
  proven: 0, partially_proven: 1, claimed_only: 2, unknown: 3,
};

// A member run: the raw session plus its owning card (for displayName,
// status, evidence, commits).
interface Member {
  session: RawSession;
  agent: AgentReport;
}

// Evidence counts for one member (ThreadSession contract: counts only, no
// content). Commits reuse attributeCommits so "authored inside this
// session's window" means exactly what profile-level attribution means,
// grace period included.
function toThreadSession(m: Member): ThreadSession {
  const window = { startedAt: m.session.startedAt, lastEventAt: m.session.lastEventAt };
  return {
    sessionId: m.session.sessionId,
    profile: m.agent.displayName,
    startedAt: m.session.startedAt,
    lastEventAt: m.session.lastEventAt,
    files: m.session.filesTouched.length,
    commits: attributeCommits(m.agent.commits, [window]).filter((c) => c.attributed).length,
    errors: m.session.errors.length,
  };
}

function buildThread(threadKey: string, source: TaskThread["source"], title: string, members: Member[]): TaskThread {
  const sessions = members
    .map(toThreadSession)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.sessionId.localeCompare(b.sessionId));
  const worst = members.reduce((acc, m) => (STATUS_RANK[m.agent.status] < STATUS_RANK[acc.agent.status] ? m : acc));
  const strongest = members.reduce((acc, m) => (EVIDENCE_RANK[m.agent.evidence] < EVIDENCE_RANK[acc.agent.evidence] ? m : acc));
  const workdirs = new Set(members.map((m) => m.agent.workdir));
  return {
    threadKey,
    source,
    title,
    status: worst.agent.status,
    evidence: strongest.agent.evidence,
    firstActivityAt: sessions[0]!.startedAt,
    lastActivityAt: sessions.reduce((max, s) => (s.lastEventAt > max ? s.lastEventAt : max), ""),
    sessions,
    ...(workdirs.size === 1 ? { workdir: [...workdirs][0]! } : {}),
  };
}

// Union-find over member indices for the file-cluster fallback.
function findRoot(parent: number[], i: number): number {
  while (parent[i] !== i) {
    parent[i] = parent[parent[i]!]!;
    i = parent[i]!;
  }
  return i;
}

// File-cluster threads over the members no bead key claimed: connected
// components under "shares ≥ MIN_SHARED_FILES files", pairwise — O(n²) set
// intersections over a morning's session count is noise. The cluster key is
// the lexicographically-first file shared inside the component (stable
// across runs); the title names shared-file basenames.
function fileClusterThreads(members: Member[], redactPatterns: string[]): TaskThread[] {
  const withFiles = members.filter((m) => m.session.filesTouched.length >= MIN_SHARED_FILES);
  const fileSets = withFiles.map((m) => new Set(m.session.filesTouched));
  const parent = withFiles.map((_, i) => i);
  for (let i = 0; i < withFiles.length; i++) {
    for (let j = i + 1; j < withFiles.length; j++) {
      let shared = 0;
      for (const f of fileSets[i]!) if (fileSets[j]!.has(f) && ++shared >= MIN_SHARED_FILES) break;
      if (shared >= MIN_SHARED_FILES) parent[findRoot(parent, i)] = findRoot(parent, j);
    }
  }
  const components = new Map<number, Member[]>();
  for (let i = 0; i < withFiles.length; i++) {
    const root = findRoot(parent, i);
    let c = components.get(root);
    if (!c) components.set(root, (c = []));
    c.push(withFiles[i]!);
  }

  const threads: TaskThread[] = [];
  for (const component of components.values()) {
    if (component.length < MIN_THREAD_SESSIONS) continue;
    // Files the cluster actually shares: touched by ≥2 members. Non-empty by
    // construction — every union edge required MIN_SHARED_FILES such files.
    const counts = new Map<string, number>();
    for (const m of component) for (const f of new Set(m.session.filesTouched)) counts.set(f, (counts.get(f) ?? 0) + 1);
    const shared = [...counts.entries()].filter(([, n]) => n >= 2).map(([f]) => f).sort();
    const names = [...new Set(shared.map((f) => basename(f)))];
    const title = names.slice(0, MAX_TITLE_FILES).join(", ") +
      (names.length > MAX_TITLE_FILES ? ` +${names.length - MAX_TITLE_FILES} more` : "");
    // Defense in depth, same contract as facts/commit subjects: paths are
    // harness-sourced (not tapes), but a secret-bearing path must still be
    // redacted at the model layer, not left for the CLI's render pass.
    threads.push(buildThread(
      redact(`files:${shared[0]!}`, redactPatterns), "files", redact(title, redactPatterns), component,
    ));
  }
  return threads;
}

// Derive the report's task threads. keysBySession maps harness session ids
// to shape-validated bead keys (already redact-filtered at the engram
// boundary); pass an empty map when the engram connector is disabled. Pure:
// reads agents/profiles, mutates nothing.
export function deriveTaskThreads(
  agents: AgentReport[],
  profiles: AgentProfile[],
  keysBySession: ReadonlyMap<string, string[]>,
  redactPatterns: string[],
): TaskThread[] {
  const agentByProfile = new Map(agents.map((a) => [a.profileId, a]));
  // One member per harness session id: Task-tool subagent transcripts
  // inherit the dispatching session's sessionId (same duplicate source as
  // the lineage probe's `probed` set), and a duplicated id must not let one
  // logical run masquerade as a two-session thread. First occurrence wins.
  const members: Member[] = [];
  const seen = new Set<string>();
  for (const profile of profiles) {
    const agent = agentByProfile.get(profile.profileId);
    if (!agent) continue; // trivial-filtered profile: its sessions never join a thread
    for (const session of profile.sessions) {
      if (seen.has(session.sessionId)) continue;
      seen.add(session.sessionId);
      members.push({ session, agent });
    }
  }

  // Bead-ID threads first (the preferred key). A session mentioning several
  // beads genuinely advanced several tasks and joins each thread.
  const byKey = new Map<string, Member[]>();
  for (const m of members) {
    for (const key of keysBySession.get(m.session.sessionId) ?? []) {
      let list = byKey.get(key);
      if (!list) byKey.set(key, (list = []));
      list.push(m);
    }
  }
  const threads: TaskThread[] = [];
  const claimed = new Set<string>();
  for (const [key, list] of [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (list.length < MIN_THREAD_SESSIONS) continue;
    threads.push(buildThread(key, "bead", key, list));
    for (const m of list) claimed.add(m.session.sessionId);
  }

  // File-cluster fallback over the unclaimed remainder only, so a run never
  // appears in both a bead thread and a file thread for the same work.
  // Accepted asymmetry: an unclaimed session whose only file overlap is with
  // a bead-claimed session stays unthreaded — preferring a missed grouping
  // over double-reporting the claimed run.
  threads.push(...fileClusterThreads(members.filter((m) => !claimed.has(m.session.sessionId)), redactPatterns));

  // Bead threads before file clusters (key quality order), then worst status
  // first (exceptions-first, like the agent sort), most recent activity, key.
  return threads.sort((a, b) =>
    (a.source === b.source ? 0 : a.source === "bead" ? -1 : 1) ||
    STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
    b.lastActivityAt.localeCompare(a.lastActivityAt) ||
    a.threadKey.localeCompare(b.threadKey));
}
