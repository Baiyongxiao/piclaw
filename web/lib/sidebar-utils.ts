import type { SessionInfo } from "./types";

/** Return the N most recently active cwds across all sessions */
export function getRecentCwds(sessions: SessionInfo[], limit = 5): string[] {
  const latestByCwd = new Map<string, string>();
  for (const s of sessions) {
    if (!s.cwd) continue;
    const prev = latestByCwd.get(s.cwd);
    if (!prev || s.modified > prev) {
      latestByCwd.set(s.cwd, s.modified);
    }
  }
  return [...latestByCwd.entries()]
    .sort((a, b) => new Date(b[1]).getTime() - new Date(a[1]).getTime())
    .slice(0, limit)
    .map(([cwd]) => cwd);
}
