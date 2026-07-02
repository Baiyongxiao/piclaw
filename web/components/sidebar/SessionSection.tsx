"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { SessionSearch } from "@/components/SessionSearch";
import { CollapsibleSection } from "./CollapsibleSection";
import type { SessionInfo } from "@/lib/types";
import { SessionTreeItem, buildSessionTree } from "./SessionTree";
import type { SessionTreeNode } from "./SessionTree";

/* ── Props ──────────────────────────────────────────────────────── */

interface Props {
  selectedSessionId: string | null;
  onSelectSession: (session: SessionInfo) => void;
  onSessionDeleted: (sessionId: string) => void;
  refreshKey: number;
  selectedCwd: string | null;
  onNavigateToEntry?: (sessionId: string, entryId: string) => void;
}

/* ── Refresh icon ───────────────────────────────────────────────── */

function RefreshIcon({ done }: { done: boolean }) {
  if (done) {
    return (
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="#4ade80"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="20 6 9 17 4 12" />
      </svg>
    );
  }
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

function SearchIcon({ active }: { active: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke={active ? "var(--accent)" : "currentColor"}
      strokeWidth="2.2"
      strokeLinecap="round"
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

/* ── Component ──────────────────────────────────────────────────── */

export function SessionSection({
  selectedSessionId,
  onSelectSession,
  onSessionDeleted,
  refreshKey,
  selectedCwd,
  onNavigateToEntry,
}: Props) {
  // ── Session data ──────────────────────────────────────────────
  const [allSessions, setAllSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sessionRefreshDone, setSessionRefreshDone] = useState(false);
  const sessionRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadSessionsAbortRef = useRef<AbortController | null>(null);

  // ── Search popup ──────────────────────────────────────────────
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchPopupPos, setSearchPopupPos] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);
  const searchContainerRef = useRef<HTMLDivElement>(null);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
      loadSessionsAbortRef.current?.abort();
    };
  }, []);

  // Load sessions
  const loadSessions = useCallback(
    async (showLoading = false) => {
      loadSessionsAbortRef.current?.abort();
      const controller = new AbortController();
      loadSessionsAbortRef.current = controller;
      try {
        if (showLoading) setLoading(true);
        const res = await fetch("/api/sessions", { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { sessions: SessionInfo[] };
        if (controller.signal.aborted) return;
        setAllSessions(data.sessions);
        setError(null);
        if (!showLoading) {
          setSessionRefreshDone(true);
          if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
          sessionRefreshTimerRef.current = setTimeout(() => setSessionRefreshDone(false), 2000);
        }
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") return;
        setError(String(e));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [],
  );

  const initialLoadDone = useRef(false);
  useEffect(() => {
    const isFirst = !initialLoadDone.current;
    initialLoadDone.current = true;
    loadSessions(isFirst);
  }, [loadSessions, refreshKey]);

  // ── Filter sessions by cwd ────────────────────────────────────
  const filteredSessions = selectedCwd
    ? allSessions.filter((s) => s.cwd === selectedCwd)
    : allSessions;

  const sessionTree = buildSessionTree(filteredSessions);

  // ── Search toggle ────────────────────────────────────────────
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchPopupPos(null);
  }, []);

  const handleSearchToggle = useCallback(
    (e: React.MouseEvent) => {
      if (searchOpen) {
        closeSearch();
      } else {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setSearchPopupPos({
          top: rect.bottom + 4,
          left: Math.max(8, rect.left - 240),
          width: 280,
        });
        setSearchOpen(true);
      }
    },
    [searchOpen, closeSearch],
  );

  // Outside click for search
  useEffect(() => {
    if (!searchOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        searchContainerRef.current &&
        !searchContainerRef.current.contains(e.target as Node)
      ) {
        closeSearch();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [searchOpen, closeSearch]);

  // ── Render ────────────────────────────────────────────────────
  return (
    <>
      <CollapsibleSection
        label="Sessions"
        defaultOpen={true}
        autoHideActions={true}
        onToggle={(open) => {
          if (!open) closeSearch();
        }}
        actions={[
          {
            icon: <SearchIcon active={searchOpen} />,
            onClick: handleSearchToggle,
            title: "Search sessions",
            active: searchOpen,
          },
          {
            icon: <RefreshIcon done={sessionRefreshDone} />,
            onClick: () => loadSessions(false),
            title: "Refresh",
            done: sessionRefreshDone,
          },
        ]}
      >
        {/* Session list */}
        <div style={{ overflowY: "auto", overflowX: "hidden", flex: 1, minHeight: 80 }}>
          {loading && (
            <div style={{ padding: "16px 14px", color: "var(--text-muted)", fontSize: 12 }}>
              Loading...
            </div>
          )}
          {error && (
            <div style={{ padding: "12px 14px", color: "#f87171", fontSize: 12 }}>{error}</div>
          )}
          {!loading && !error && filteredSessions.length === 0 && (
            <div style={{ padding: "16px 14px", color: "var(--text-muted)", fontSize: 12 }}>
              No sessions found
            </div>
          )}
          {sessionTree.map((node) => (
            <SessionTreeItem
              key={node.session.id}
              node={node}
              selectedSessionId={selectedSessionId}
              onSelectSession={onSelectSession}
              onRenamed={() => loadSessions(false)}
              onSessionDeleted={(id) => {
                onSessionDeleted(id);
                loadSessions();
              }}
              depth={0}
            />
          ))}
        </div>
      </CollapsibleSection>

      {/* ── Floating session search popup ──────────────────────── */}
      {searchOpen && searchPopupPos && (
        <div
          ref={searchContainerRef}
          style={{
            position: "fixed",
            top: searchPopupPos.top,
            left: searchPopupPos.left,
            width: searchPopupPos.width,
            zIndex: 9999,
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            boxShadow: "0 6px 24px rgba(0,0,0,0.18)",
            overflow: "visible",
            maxHeight: "min(420px, 65vh)",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <SessionSearch
            cwd={selectedCwd}
            onNavigateToEntry={(sessionId, entryId) => {
              const session = allSessions.find((s) => s.id === sessionId);
              if (session) {
                closeSearch();
                onSelectSession(session);
                onNavigateToEntry?.(sessionId, entryId);
              }
            }}
          />
        </div>
      )}
    </>
  );
}
