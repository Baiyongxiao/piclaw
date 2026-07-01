"use client";

import { useState, useCallback, useEffect, useRef } from "react";

interface SearchMatch {
  sessionId: string;
  sessionName?: string;
  sessionModified: string;
  sessionMessageCount: number;
  entryId: string;
  role: string;
  snippet: string;
  matchStart: number;
  matchEnd: number;
}

interface Props {
  cwd: string | null;
  onNavigateToEntry: (sessionId: string, entryId: string) => void;
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

/**
 * Render snippet text with the matched keyword highlighted.
 * Position is calculated by the server (matchStart/matchEnd).
 */
function HighlightedSnippet({
  text,
  matchStart,
  matchEnd,
}: {
  text: string;
  matchStart: number;
  matchEnd: number;
}) {
  if (matchStart >= matchEnd || matchStart < 0 || matchEnd > text.length) {
    return <>{text}</>;
  }

  const before = text.slice(0, matchStart);
  const match = text.slice(matchStart, matchEnd);
  const after = text.slice(matchEnd);

  return (
    <>
      {before}
      <mark
        style={{
          background: "rgba(37,99,235,0.12)",
          color: "var(--accent)",
          borderRadius: 2,
          padding: "0 1px",
        }}
      >
        {match}
      </mark>
      {after}
    </>
  );
}

export function SessionSearch({ cwd, onNavigateToEntry }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchMatch[]>([]);
  const [loading, setLoading] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);

  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // ── Search ────────────────────────────────────────────────────────

  const performSearch = useCallback(
    async (q: string) => {
      if (!cwd || !q.trim()) {
        setResults([]);
        setShowResults(false);
        setActiveIdx(-1);
        return;
      }

      // Abort any in-flight request
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      try {
        const params = new URLSearchParams({ q: q.trim(), cwd });
        const res = await fetch(`/api/sessions/search?${params}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as { results: SearchMatch[] };
        setResults(data.results);
        setShowResults(data.results.length > 0);
        setActiveIdx(-1);
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        // Silently fail — don't disturb the user
        setResults([]);
        setShowResults(false);
      } finally {
        setLoading(false);
      }
    },
    [cwd],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      setQuery(val);

      if (debounceRef.current) clearTimeout(debounceRef.current);

      if (!val.trim()) {
        setResults([]);
        setShowResults(false);
        setActiveIdx(-1);
        return;
      }

      debounceRef.current = setTimeout(() => void performSearch(val), 300);
    },
    [performSearch],
  );

  // ── Keyboard navigation ───────────────────────────────────────────

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!showResults || results.length === 0) {
        if (e.key === "Escape") {
          inputRef.current?.blur();
        }
        return;
      }

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setActiveIdx((prev) =>
            prev < results.length - 1 ? prev + 1 : 0,
          );
          break;
        case "ArrowUp":
          e.preventDefault();
          setActiveIdx((prev) =>
            prev > 0 ? prev - 1 : results.length - 1,
          );
          break;
        case "Enter":
          e.preventDefault();
          if (activeIdx >= 0 && activeIdx < results.length) {
            const r = results[activeIdx];
            setShowResults(false);
            setQuery("");
            onNavigateToEntry(r.sessionId, r.entryId);
          }
          break;
        case "Escape":
          e.preventDefault();
          setShowResults(false);
          inputRef.current?.blur();
          break;
      }
    },
    [showResults, results, activeIdx, onNavigateToEntry],
  );

  // ── Click outside ─────────────────────────────────────────────────

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setShowResults(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // ── Clear results when cwd changes ─────────────────────────────────

  useEffect(() => {
    setQuery("");
    setResults([]);
    setShowResults(false);
    setActiveIdx(-1);
  }, [cwd]);

  const resultCount = results.length;

  return (
    <div
      ref={containerRef}
      style={{
        position: "relative",
        padding: "4px 10px 2px",
        flexShrink: 0,
      }}
    >
      {/* ── Search input ── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          height: 30,
          padding: "0 8px",
          background: "var(--bg-hover)",
          border: "1px solid var(--border)",
          borderRadius: 7,
          transition: "border-color 0.15s",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = "var(--text-dim)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = "var(--border)";
        }}
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--text-dim)"
          strokeWidth="2.2"
          strokeLinecap="round"
          style={{ flexShrink: 0 }}
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={() => {
            if (results.length > 0) setShowResults(true);
          }}
          placeholder="Search sessions…"
          aria-label="Search session content"
          style={{
            flex: 1,
            border: "none",
            background: "none",
            outline: "none",
            color: "var(--text)",
            fontSize: 12,
            fontFamily: "inherit",
            lineHeight: 1,
            padding: 0,
            minWidth: 0,
          }}
        />
        {loading && (
          <span
            style={{
              width: 11,
              height: 11,
              flexShrink: 0,
              color: "var(--text-dim)",
              fontSize: 10,
              lineHeight: 1,
            }}
          >
            ⋯
          </span>
        )}
      </div>

      {/* ── Results dropdown ── */}
      {showResults && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 8,
            right: 8,
            zIndex: 150,
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            boxShadow: "0 6px 20px rgba(0,0,0,0.10)",
            overflow: "hidden",
            maxHeight: "min(340px, 60vh)",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {/* Result count */}
          <div
            style={{
              padding: "5px 10px",
              fontSize: 10,
              color: "var(--text-dim)",
              borderBottom: "1px solid var(--border)",
              flexShrink: 0,
              letterSpacing: "0.03em",
            }}
          >
            {resultCount} {resultCount === 1 ? "result" : "results"}
          </div>

          {/* Scrollable list */}
          <div style={{ overflowY: "auto", flex: 1 }}>
            {results.map((r, i) => (
              <button
                key={`${r.sessionId}-${r.entryId}`}
                onClick={() => {
                  setShowResults(false);
                  setQuery("");
                  onNavigateToEntry(r.sessionId, r.entryId);
                }}
                onMouseEnter={() => setActiveIdx(i)}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 3,
                  width: "100%",
                  padding: "7px 10px",
                  background:
                    i === activeIdx ? "var(--bg-hover)" : "transparent",
                  border: "none",
                  borderBottom:
                    i < results.length - 1
                      ? "1px solid var(--border)"
                      : "none",
                  borderLeft: i === activeIdx
                    ? "2px solid var(--accent)"
                    : "2px solid transparent",
                  cursor: "pointer",
                  textAlign: "left",
                  transition: "background 0.08s, border-color 0.08s",
                }}
              >
                {/* Session name + meta */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    minWidth: 0,
                  }}
                >
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 500,
                      color: "var(--text)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      flex: 1,
                      minWidth: 0,
                    }}
                    title={r.sessionName ?? r.sessionId}
                  >
                    {r.sessionName ?? "Untitled session"}
                  </span>
                  <span
                    style={{
                      fontSize: 10,
                      color: "var(--text-dim)",
                      flexShrink: 0,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {formatRelativeTime(r.sessionModified)}
                  </span>
                </div>

                {/* Snippet — the signature element: grep-like monospace output */}
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--text-muted)",
                    lineHeight: 1.45,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontFamily: "var(--font-mono)",
                  }}
                  title={r.snippet}
                >
                  <HighlightedSnippet
                    text={r.snippet}
                    matchStart={r.matchStart}
                    matchEnd={r.matchEnd}
                  />
                </div>

                {/* Role badge */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    fontSize: 10,
                    color: "var(--text-dim)",
                  }}
                >
                  <span
                    style={{
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                      opacity: 0.75,
                    }}
                  >
                    {r.role}
                  </span>
                  <span>·</span>
                  <span>{r.sessionMessageCount} msgs</span>
                </div>
              </button>
            ))}
          </div>

          {/* Keyboard hint */}
          <div
            style={{
              padding: "4px 10px",
              fontSize: 10,
              color: "var(--text-dim)",
              borderTop: "1px solid var(--border)",
              flexShrink: 0,
              display: "flex",
              gap: 10,
            }}
          >
            <span>
              <kbd
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 9,
                  padding: "1px 4px",
                  borderRadius: 3,
                  background: "var(--bg-hover)",
                  border: "1px solid var(--border)",
                }}
              >
                ↑↓
              </kbd>{" "}
              navigate
            </span>
            <span>
              <kbd
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 9,
                  padding: "1px 4px",
                  borderRadius: 3,
                  background: "var(--bg-hover)",
                  border: "1px solid var(--border)",
                }}
              >
                ↵
              </kbd>{" "}
              jump
            </span>
            <span>
              <kbd
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 9,
                  padding: "1px 4px",
                  borderRadius: 3,
                  background: "var(--bg-hover)",
                  border: "1px solid var(--border)",
                }}
              >
                esc
              </kbd>{" "}
              close
            </span>
          </div>
        </div>
      )}

      {/* ── Show count badge when results exist but dropdown is closed ── */}
      {!showResults && query.trim() && !loading && results.length > 0 && (
        <div
          style={{
            marginTop: 2,
            fontSize: 10,
            color: "var(--text-dim)",
            paddingLeft: 2,
          }}
        >
          {resultCount} {resultCount === 1 ? "match" : "matches"} —
          <button
            onClick={() => setShowResults(true)}
            style={{
              background: "none",
              border: "none",
              color: "var(--accent)",
              cursor: "pointer",
              fontSize: 10,
              padding: 0,
              marginLeft: 4,
            }}
          >
            show
          </button>
        </div>
      )}
    </div>
  );
}
