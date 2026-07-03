import type { SessionInfo } from "./types";

/** Return all recently active cwds across all sessions, sorted by most recent first */
export function getRecentCwds(sessions: SessionInfo[]): string[] {
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
    .map(([cwd]) => cwd);
}
