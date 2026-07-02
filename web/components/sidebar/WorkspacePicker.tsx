"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import type { SessionInfo } from "@/lib/types";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { getRecentCwds } from "@/lib/sidebar-utils";

/* ── Helpers ────────────────────────────────────────────────────── */

function shortenCwd(cwd: string, homeDir?: string): string {
  const path =
    homeDir && cwd.startsWith(homeDir) ? "~" + cwd.slice(homeDir.length) : cwd;
  const sep = path.includes("/") ? "/" : "\\";
  const parts = path.split(sep).filter(Boolean);
  if (parts.length <= 2) return path;
  return "…/" + parts.slice(-2).join(sep);
}

/* ── Props ──────────────────────────────────────────────────────── */

interface Props {
  /** Currently selected working directory (from parent) */
  cwd: string | null;
  /** Change callback */
  onCwdChange: (cwd: string | null) => void;
  /** All available sessions — used to build recent-cwd list */
  allSessions: SessionInfo[];
  /** Whether sessions are still loading */
  sessionsLoading: boolean;
}

/* ── Component ──────────────────────────────────────────────────── */

export function WorkspacePicker({
  cwd,
  onCwdChange,
  allSessions,
  sessionsLoading,
}: Props) {
  const [homeDir, setHomeDir] = useState("");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [customPathOpen, setCustomPathOpen] = useState(false);
  const [customPathValue, setCustomPathValue] = useState("");
  const [customPathError, setCustomPathError] = useState<string | null>(null);
  const [customPathValidating, setCustomPathValidating] = useState(false);
  const [customPathMissingCwd, setCustomPathMissingCwd] = useState<string | null>(null);
  const [customPathCreating, setCustomPathCreating] = useState(false);
  const customPathInputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Fetch home directory
  useEffect(() => {
    fetch("/api/home")
      .then((r) => r.json())
      .then((d: { home?: string }) => {
        if (d.home) setHomeDir(d.home);
      })
      .catch(() => {});
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
        setCustomPathOpen(false);
        setCustomPathValue("");
        setCustomPathError(null);
        setCustomPathMissingCwd(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const commitCustomPath = useCallback(async () => {
    const path = customPathValue.trim();
    if (!path || customPathValidating) return;

    setCustomPathValidating(true);
    setCustomPathError(null);
    setCustomPathMissingCwd(null);
    try {
      const res = await fetch("/api/cwd/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: path, currentCwd: cwd ?? undefined }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        exists?: boolean;
        cwd?: string;
        error?: string;
      };
      if (!res.ok && data.error) {
        setCustomPathError(data.error);
        return;
      }
      if (data.error) {
        setCustomPathError(data.error);
        return;
      }
      if (res.ok && data.exists) {
        onCwdChange(data.cwd!);
        setCustomPathOpen(false);
        setCustomPathValue("");
        setDropdownOpen(false);
      } else if (res.ok) {
        setCustomPathMissingCwd(data.cwd ?? path);
      }
    } catch (e) {
      setCustomPathError(e instanceof Error ? e.message : String(e));
    } finally {
      setCustomPathValidating(false);
    }
  }, [customPathValue, customPathValidating, cwd, onCwdChange]);

  const handleCreateDirectory = useCallback(async () => {
    const target = customPathMissingCwd;
    if (!target || customPathCreating) return;

    setCustomPathCreating(true);
    setCustomPathError(null);
    try {
      const res = await fetch("/api/cwd/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: target, currentCwd: cwd ?? undefined }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        cwd?: string;
        error?: string;
      };
      if (!res.ok || data.error) {
        setCustomPathError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      onCwdChange(data.cwd ?? target);
      setCustomPathMissingCwd(null);
      setCustomPathOpen(false);
      setCustomPathValue("");
      setDropdownOpen(false);
    } catch (e) {
      setCustomPathError(e instanceof Error ? e.message : String(e));
    } finally {
      setCustomPathCreating(false);
    }
  }, [customPathMissingCwd, customPathCreating, cwd, onCwdChange]);

  const handleDefaultCwd = useCallback(async () => {
    try {
      const res = await fetch("/api/default-cwd", { method: "POST" });
      const data = (await res.json()) as { cwd?: string; error?: string };
      if (data.cwd) {
        onCwdChange(data.cwd);
        setCustomPathOpen(false);
        setCustomPathValue("");
        setCustomPathError(null);
        setCustomPathMissingCwd(null);
        setDropdownOpen(false);
      }
    } catch {
      // ignore
    }
  }, [onCwdChange]);

  const recentCwds = getRecentCwds(allSessions);

  return (
    <div
      style={{
        padding: "6px 10px 8px",
        borderBottom: "1px solid var(--border)",
        flexShrink: 0,
      }}
    >
      <div ref={dropdownRef} style={{ position: "relative" }}>
        <button
          onClick={() => setDropdownOpen((v) => !v)}
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            padding: "6px 10px",
            background: cwd
              ? "var(--bg-hover)"
              : "rgba(37,99,235,0.06)",
            border: cwd
              ? "1px solid var(--border)"
              : "1px solid rgba(37,99,235,0.4)",
            borderRadius: 7,
            cursor: "pointer",
            fontSize: 12,
            color: "var(--text)",
            textAlign: "left",
            transition: "border-color 0.15s, background 0.15s",
          }}
        >
          <span
            style={{
              flex: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: cwd ? "var(--text)" : "var(--text-dim)",
            }}
            title={cwd ?? ""}
          >
            {cwd
              ? shortenCwd(cwd, homeDir)
              : sessionsLoading
                ? ""
                : "Select project…"}
          </span>
        </button>

        {dropdownOpen && (
          <div
            style={{
              position: "absolute",
              top: "calc(100% + 4px)",
              left: 0,
              right: 0,
              zIndex: 100,
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              boxShadow: "0 6px 20px rgba(0,0,0,0.10)",
              overflow: "hidden",
            }}
          >
            {/* Recent cwds */}
            {recentCwds.map((rcwd) => (
              <button
                key={rcwd}
                onClick={() => {
                  onCwdChange(rcwd);
                  setCustomPathOpen(false);
                  setCustomPathValue("");
                  setCustomPathError(null);
                  setCustomPathMissingCwd(null);
                  setDropdownOpen(false);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  width: "100%",
                  padding: "8px 10px",
                  background: rcwd === cwd ? "var(--bg-selected)" : "none",
                  border: "none",
                  borderBottom: "1px solid var(--border)",
                  color: rcwd === cwd ? "var(--text)" : "var(--text-muted)",
                  cursor: "pointer",
                  textAlign: "left",
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={rcwd}
              >
                {rcwd === cwd && (
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 10 10"
                    fill="none"
                    stroke="var(--accent)"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ flexShrink: 0 }}
                  >
                    <polyline points="1.5 5 4 7.5 8.5 2.5" />
                  </svg>
                )}
                {rcwd !== cwd && <span style={{ width: 10, flexShrink: 0 }} />}
                <span
                  style={{
                    flex: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {shortenCwd(rcwd, homeDir)}
                </span>
              </button>
            ))}

            {/* Default cwd shortcut */}
            {!customPathOpen && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  void handleDefaultCwd();
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  width: "100%",
                  padding: "8px 10px",
                  background: "none",
                  border: "none",
                  borderTop: recentCwds.length > 0 ? "1px solid var(--border)" : "none",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  textAlign: "left",
                  fontSize: 11,
                }}
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 10 10"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.1"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ flexShrink: 0 }}
                >
                  <path d="M1 3A1 1 0 0 1 2 2H4L5 3.5H8.5a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 1 8V3Z" />
                </svg>
                <span>Use default directory</span>
              </button>
            )}

            {/* Custom path entry */}
            {!customPathOpen ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setCustomPathOpen(true);
                  setCustomPathError(null);
                  setCustomPathMissingCwd(null);
                  setTimeout(() => customPathInputRef.current?.focus(), 0);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  width: "100%",
                  padding: "8px 10px",
                  background: "none",
                  border: "none",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  textAlign: "left",
                  fontSize: 11,
                }}
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 10 10"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.1"
                  strokeLinecap="round"
                  style={{ flexShrink: 0 }}
                >
                  <line x1="5" y1="1" x2="5" y2="9" />
                  <line x1="1" y1="5" x2="9" y2="5" />
                </svg>
                <span>Custom path…</span>
              </button>
            ) : (
              <div
                style={{
                  padding: "6px 8px",
                  borderTop: recentCwds.length > 0 ? "none" : undefined,
                }}
              >
                <input
                  ref={customPathInputRef}
                  value={customPathValue}
                  onChange={(e) => {
                    setCustomPathValue(e.target.value);
                    setCustomPathError(null);
                    setCustomPathMissingCwd(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void commitCustomPath();
                    }
                    if (e.key === "Escape") {
                      setCustomPathOpen(false);
                      setCustomPathValue("");
                      setCustomPathError(null);
                      setCustomPathMissingCwd(null);
                    }
                  }}
                  placeholder="/path/to/project"
                  style={{
                    width: "100%",
                    fontSize: 11,
                    fontFamily: "var(--font-mono)",
                    padding: "5px 8px",
                    border: "1px solid var(--accent)",
                    borderRadius: 5,
                    outline: "none",
                    background: "var(--bg)",
                    color: "var(--text)",
                    boxSizing: "border-box",
                  }}
                />
                {customPathMissingCwd ? (
                  <div style={{ marginTop: 5 }}>
                    <div
                      style={{
                        fontSize: 11,
                        lineHeight: 1.4,
                        color: "var(--text-muted)",
                        overflowWrap: "anywhere",
                      }}
                    >
                      Directory{" "}
                      <code
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: 11,
                          background: "var(--bg-hover)",
                          padding: "1px 4px",
                          borderRadius: 3,
                        }}
                      >
                        {customPathMissingCwd}
                      </code>{" "}
                      does not exist. Create it?
                    </div>
                    <div style={{ display: "flex", gap: 5, marginTop: 6 }}>
                      <button
                        onClick={() => void handleCreateDirectory()}
                        disabled={customPathCreating}
                        style={{
                          flex: 1,
                          padding: "4px 0",
                          background: "var(--accent)",
                          border: "none",
                          borderRadius: 5,
                          color: "#fff",
                          fontSize: 11,
                          fontWeight: 600,
                          cursor: customPathCreating ? "not-allowed" : "pointer",
                          opacity: customPathCreating ? 0.65 : 1,
                        }}
                      >
                        {customPathCreating ? "Creating…" : "Create Directory"}
                      </button>
                      <button
                        onClick={() => {
                          setCustomPathMissingCwd(null);
                          setCustomPathError(null);
                        }}
                        style={{
                          flex: 1,
                          padding: "4px 0",
                          background: "var(--bg-hover)",
                          border: "1px solid var(--border)",
                          borderRadius: 5,
                          color: "var(--text-muted)",
                          fontSize: 11,
                          cursor: "pointer",
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    {customPathError && (
                      <div
                        style={{
                          marginTop: 5,
                          color: "#dc2626",
                          fontSize: 11,
                          lineHeight: 1.35,
                          overflowWrap: "anywhere",
                        }}
                      >
                        {customPathError}
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 5, marginTop: 5 }}>
                      <button
                        onClick={() => void commitCustomPath()}
                        disabled={customPathValidating || !customPathValue.trim()}
                        style={{
                          flex: 1,
                          padding: "4px 0",
                          background: "var(--accent)",
                          border: "none",
                          borderRadius: 5,
                          color: "#fff",
                          fontSize: 11,
                          fontWeight: 600,
                          cursor:
                            customPathValidating || !customPathValue.trim()
                              ? "not-allowed"
                              : "pointer",
                          opacity:
                            customPathValidating || !customPathValue.trim()
                              ? 0.65
                              : 1,
                        }}
                      >
                        {customPathValidating ? "Checking…" : "Open"}
                      </button>
                      <button
                        onClick={() => {
                          setCustomPathOpen(false);
                          setCustomPathValue("");
                          setCustomPathError(null);
                          setCustomPathMissingCwd(null);
                        }}
                        style={{
                          flex: 1,
                          padding: "4px 0",
                          background: "var(--bg-hover)",
                          border: "1px solid var(--border)",
                          borderRadius: 5,
                          color: "var(--text-muted)",
                          fontSize: 11,
                          cursor: "pointer",
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
