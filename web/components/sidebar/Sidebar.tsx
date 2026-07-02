"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import type { SessionInfo } from "@/lib/types";
import { SidebarHeader } from "./SidebarHeader";
import { WorkspacePicker } from "./WorkspacePicker";
import { getRecentCwds } from "@/lib/sidebar-utils";
import { SessionSection } from "./SessionSection";
import { ExplorerSection } from "./ExplorerSection";
import { SidebarFooter } from "./SidebarFooter";

/* ── Props ──────────────────────────────────────────────────────── */

interface Props {
  selectedSessionId: string | null;
  onSelectSession: (session: SessionInfo, isRestore?: boolean) => void;
  onNewSession: (sessionId: string, cwd: string) => void;
  onSessionDeleted: (sessionId: string) => void;
  selectedCwd: string | null;
  onCwdChange: (cwd: string | null) => void;
  onOpenFile: (filePath: string, fileName: string) => void;
  explorerRefreshKey?: number;
  onAtMention?: (relativePath: string) => void;
  onNavigateToEntry?: (sessionId: string, entryId: string) => void;
  /** Props for Models / Skills modals */
  onOpenModels: () => void;
  onOpenSkills: () => void;
  /** Initial session restore (from URL) */
  initialSessionId?: string | null;
  onInitialRestoreDone?: () => void;
  /** External trigger to reload sessions */
  refreshKey?: number;
}

/* ── Component ──────────────────────────────────────────────────── */

export function Sidebar({
  selectedSessionId,
  onSelectSession,
  onNewSession,
  onSessionDeleted,
  selectedCwd,
  onCwdChange,
  onOpenFile,
  explorerRefreshKey,
  onAtMention,
  onNavigateToEntry,
  onOpenModels,
  onOpenSkills,
  initialSessionId,
  onInitialRestoreDone,
  refreshKey: externalRefreshKey,
}: Props) {
  // ── CWD state (internal, mirrors parent) ──────────────────────
  const [cwd, setCwd] = useState<string | null>(selectedCwd);
  const [allSessions, setAllSessions] = useState<SessionInfo[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const autoSelectDone = useRef(false);
  const restoredRef = useRef(false);

  // Sync from parent
  useEffect(() => {
    setCwd(selectedCwd);
  }, [selectedCwd]);

  // Load sessions once for the recent-cwd list and initial restore
  useEffect(() => {
    fetch("/api/sessions")
      .then((r) => r.json())
      .then((data: { sessions: SessionInfo[] }) => {
        setAllSessions(data.sessions);
        setSessionsLoading(false);
      })
      .catch((err) => {
        console.error("Failed to load sessions:", err);
        setSessionsLoading(false);
      });
  }, []);

  // Auto-select cwd: handle initial session restore OR most recent cwd
  useEffect(() => {
    if (sessionsLoading || allSessions.length === 0) return;
    if (autoSelectDone.current) return;

    // Check for initial session restore from URL
    if (initialSessionId && !restoredRef.current) {
      restoredRef.current = true;
      const target = allSessions.find((s) => s.id === initialSessionId);
      if (target) {
        setCwd(target.cwd);
        onCwdChange(target.cwd);
        onSelectSession(target, true);
        autoSelectDone.current = true;
        return;
      }
      // Session not found — notify parent
      onInitialRestoreDone?.();
      autoSelectDone.current = true;
      return;
    }

    // Auto-select most recent cwd
    if (cwd === null && !autoSelectDone.current) {
      autoSelectDone.current = true;
      const recent = getRecentCwds(allSessions);
      if (recent.length > 0) {
        setCwd(recent[0]);
        onCwdChange(recent[0]);
      }
    }
  }, [cwd, sessionsLoading, allSessions, onCwdChange, initialSessionId, onSelectSession, onInitialRestoreDone]);

  const handleCwdChange = useCallback(
    (newCwd: string | null) => {
      setCwd(newCwd);
      onCwdChange(newCwd);
    },
    [onCwdChange],
  );

  const handleNewSession = useCallback(() => {
    if (!cwd) return;
    const tempId =
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    onNewSession(tempId, cwd);
  }, [cwd, onNewSession]);

  // ── Refresh key for sessions (combines external + internal) ──
  const [internalRefreshKey, setInternalRefreshKey] = useState(0);
  // Combine external and internal refresh keys: each external bump also bumps internal
  useEffect(() => {
    if (externalRefreshKey !== undefined && externalRefreshKey > 0) {
      setInternalRefreshKey((k) => k + 1);
    }
  }, [externalRefreshKey]);

  const handleSessionDeleted = useCallback(
    (sessionId: string) => {
      setInternalRefreshKey((k) => k + 1);
      onSessionDeleted(sessionId);
    },
    [onSessionDeleted],
  );

  // ── Render ────────────────────────────────────────────────────
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        overflow: "hidden",
      }}
    >
      {/* 1. Header: title + New button */}
      <SidebarHeader selectedCwd={cwd} onNewSession={handleNewSession} />

      {/* 2. Workspace: CWD picker */}
      <WorkspacePicker
        cwd={cwd}
        onCwdChange={handleCwdChange}
        allSessions={allSessions}
        sessionsLoading={sessionsLoading}
      />

      {/* 3. Sessions management (collapsible, upward collapse) */}
      <SessionSection
        selectedSessionId={selectedSessionId}
        onSelectSession={onSelectSession}
        onSessionDeleted={handleSessionDeleted}
        refreshKey={internalRefreshKey}
        selectedCwd={cwd}
        onNavigateToEntry={onNavigateToEntry}
      />

      {/* 4. File explorer (collapsible, upward collapse) */}
      <ExplorerSection
        cwd={cwd}
        onOpenFile={onOpenFile}
        explorerRefreshKey={explorerRefreshKey}
        onAtMention={onAtMention}
      />

      {/* 5. Footer: Models + Skills buttons */}
      <SidebarFooter
        hasCwd={cwd !== null}
        onOpenModels={onOpenModels}
        onOpenSkills={onOpenSkills}
      />
    </div>
  );
}
