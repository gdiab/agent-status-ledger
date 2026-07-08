import { basename } from "node:path";
import type { AgentProfile, RawSession } from "./types";

export function resolveProfiles(sessions: RawSession[]): AgentProfile[] {
  const map = new Map<string, AgentProfile>();
  for (const s of sessions) {
    const key = `${s.platform}:${s.cwd}`;
    let profile = map.get(key);
    if (!profile) {
      profile = {
        profileId: key,
        platform: s.platform,
        workdir: s.cwd,
        displayName: `${basename(s.cwd) || s.cwd} (${s.platform})`,
        sessions: [],
      };
      map.set(key, profile);
    }
    profile.sessions.push(s);
  }
  for (const p of map.values()) {
    p.sessions.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }
  return [...map.values()].sort((a, b) => a.profileId.localeCompare(b.profileId));
}
