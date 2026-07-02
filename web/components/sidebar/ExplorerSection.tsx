"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { FileExplorer } from "@/components/FileExplorer";
import { CollapsibleSection } from "./CollapsibleSection";
import { encodeFilePathForApi } from "@/lib/file-paths";

/* ── Icon components ─────────────────────────────────────────────── */

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

function UploadIcon({ uploading, done }: { uploading: boolean; done: boolean }) {
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
  if (uploading) {
    return (
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4" />
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
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

/* ── Props ──────────────────────────────────────────────────────── */

interface Props {
  cwd: string | null;
  onOpenFile: (filePath: string, fileName: string) => void;
  explorerRefreshKey?: number;
  onAtMention?: (relativePath: string) => void;
}

/* ── Explorer Section ───────────────────────────────────────────── */

export function ExplorerSection({
  cwd,
  onOpenFile,
  explorerRefreshKey,
  onAtMention,
}: Props) {
  if (!cwd) return null;

  // ── Explorer key for refreshing ──────────────────────────────
  const [explorerKey, setExplorerKey] = useState(0);
  const [explorerRefreshDone, setExplorerRefreshDone] = useState(false);
  const explorerRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (explorerRefreshKey !== undefined) setExplorerKey((k) => k + 1);
  }, [explorerRefreshKey]);

  useEffect(() => {
    return () => {
      if (explorerRefreshTimerRef.current) clearTimeout(explorerRefreshTimerRef.current);
    };
  }, []);

  const handleRefresh = useCallback(() => {
    setExplorerKey((k) => k + 1);
    setExplorerRefreshDone(true);
    if (explorerRefreshTimerRef.current) clearTimeout(explorerRefreshTimerRef.current);
    explorerRefreshTimerRef.current = setTimeout(() => setExplorerRefreshDone(false), 2000);
  }, []);

  // ── File search ──────────────────────────────────────────────
  const [fileSearchOpen, setFileSearchOpen] = useState(false);
  const [fileSearchQuery, setFileSearchQuery] = useState("");
  const [fileSearchResults, setFileSearchResults] = useState<
    { name: string; fullPath: string; relativePath: string; isDir: boolean; size: number; modified: string }[]
  >([]);
  const [fileSearchLoading, setFileSearchLoading] = useState(false);
  const [searchPopupPos, setSearchPopupPos] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);
  const fileSearchInputRef = useRef<HTMLInputElement>(null);
  const fileSearchContainerRef = useRef<HTMLDivElement>(null);
  const fileSearchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileSearchAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      if (fileSearchDebounceRef.current) clearTimeout(fileSearchDebounceRef.current);
      fileSearchAbortRef.current?.abort();
    };
  }, []);

  const performFileSearch = useCallback(
    async (q: string) => {
      if (!cwd || !q.trim()) {
        setFileSearchResults([]);
        return;
      }

      fileSearchAbortRef.current?.abort();
      const controller = new AbortController();
      fileSearchAbortRef.current = controller;

      setFileSearchLoading(true);
      try {
        const params = new URLSearchParams({ q: q.trim(), cwd });
        const res = await fetch(`/api/files/search?${params}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { results: typeof fileSearchResults };
        setFileSearchResults(data.results);
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        console.error("File search failed:", err);
        setFileSearchResults([]);
      } finally {
        setFileSearchLoading(false);
      }
    },
    [cwd],
  );

  const handleFileSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      setFileSearchQuery(val);

      if (fileSearchDebounceRef.current) clearTimeout(fileSearchDebounceRef.current);

      if (!val.trim()) {
        setFileSearchResults([]);
        return;
      }

      fileSearchDebounceRef.current = setTimeout(() => void performFileSearch(val), 300);
    },
    [performFileSearch],
  );

  const closeFileSearch = useCallback(() => {
    setFileSearchOpen(false);
    setFileSearchQuery("");
    setFileSearchResults([]);
    setSearchPopupPos(null);
  }, []);

  const handleSearchToggle = useCallback(
    (e: React.MouseEvent) => {
      if (fileSearchOpen) {
        closeFileSearch();
      } else {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setSearchPopupPos({
          top: rect.bottom + 4,
          left: Math.max(8, rect.left - 240),
          width: 280,
        });
        setFileSearchOpen(true);
        setTimeout(() => fileSearchInputRef.current?.focus(), 0);
      }
    },
    [fileSearchOpen, closeFileSearch],
  );

  // Outside click for file search
  useEffect(() => {
    if (!fileSearchOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        fileSearchContainerRef.current &&
        !fileSearchContainerRef.current.contains(e.target as Node)
      ) {
        closeFileSearch();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [fileSearchOpen, closeFileSearch]);

  // ── Upload ───────────────────────────────────────────────────
  const [uploadDir, setUploadDir] = useState("");
  const [uploadDirOpen, setUploadDirOpen] = useState(false);
  const [subdirs, setSubdirs] = useState<string[]>([]);
  const [browsingPath, setBrowsingPath] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadDone, setUploadDone] = useState(false);
  const [uploadPopupPos, setUploadPopupPos] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadDirRef = useRef<HTMLDivElement>(null);
  const uploadDoneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (uploadDoneTimerRef.current) clearTimeout(uploadDoneTimerRef.current);
    };
  }, []);

  const fetchSubdirsAt = useCallback(
    async (relPath: string) => {
      if (!cwd) return;
      try {
        const targetDir = relPath ? cwd + "/" + relPath : cwd;
        const encoded = encodeFilePathForApi(targetDir);
        const res = await fetch(`/api/files/${encoded}?type=list`);
        if (!res.ok) {
          setSubdirs([]);
          return;
        }
        const data = (await res.json()) as { entries?: { name: string; isDir: boolean }[] };
        const dirs = (data.entries ?? []).filter((e) => e.isDir).map((e) => e.name);
        setSubdirs(dirs);
      } catch {
        setSubdirs([]);
      }
    },
    [cwd],
  );

  const navigateInto = useCallback(
    (dirName: string) => {
      const next = browsingPath ? browsingPath + "/" + dirName : dirName;
      setBrowsingPath(next);
      fetchSubdirsAt(next);
    },
    [browsingPath, fetchSubdirsAt],
  );

  const navigateTo = useCallback(
    (relPath: string) => {
      setBrowsingPath(relPath);
      fetchSubdirsAt(relPath);
    },
    [fetchSubdirsAt],
  );

  const handleUpload = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0 || !cwd) return;

      setUploading(true);
      try {
        const targetDir = uploadDir ? cwd + "/" + uploadDir : cwd;
        const formData = new FormData();
        for (let i = 0; i < files.length; i++) {
          formData.append("files", files[i]);
        }
        formData.append("targetDir", targetDir);

        const res = await fetch("/api/files/upload", {
          method: "POST",
          body: formData,
        });
        if (res.ok) {
          setExplorerKey((k) => k + 1);
          setUploadDone(true);
          if (uploadDoneTimerRef.current) clearTimeout(uploadDoneTimerRef.current);
          uploadDoneTimerRef.current = setTimeout(() => setUploadDone(false), 2000);
        } else {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          console.error("Upload failed:", data.error ?? `HTTP ${res.status}`);
        }
      } catch (e) {
        console.error("Upload error:", e);
      } finally {
        setUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [cwd, uploadDir],
  );

  const handleUploadToggle = useCallback(
    (e: React.MouseEvent) => {
      if (uploading) return;
      if (uploadDirOpen) {
        setUploadDirOpen(false);
        setUploadPopupPos(null);
      } else {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setUploadPopupPos({
          top: rect.bottom + 4,
          left: Math.max(8, rect.left - 160),
        });
        setBrowsingPath("");
        fetchSubdirsAt("");
        setUploadDirOpen(true);
      }
    },
    [uploadDirOpen, uploading, fetchSubdirsAt],
  );

  // Outside click for upload
  useEffect(() => {
    if (!uploadDirOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        uploadDirRef.current &&
        !uploadDirRef.current.contains(e.target as Node)
      ) {
        setUploadDirOpen(false);
        setUploadPopupPos(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [uploadDirOpen]);

  const breadcrumbs = browsingPath ? browsingPath.split("/") : [];

  // ── Render ──────────────────────────────────────────────────
  return (
    <>
      <CollapsibleSection
        label="Explorer"
        defaultOpen={true}
        autoHideActions={true}
        actions={[
          {
            icon: <SearchIcon active={fileSearchOpen} />,
            onClick: handleSearchToggle,
            title: "Search files",
            active: fileSearchOpen,
          },
          {
            icon: <RefreshIcon done={explorerRefreshDone} />,
            onClick: () => handleRefresh(),
            title: "Refresh explorer",
            done: explorerRefreshDone,
          },
          {
            icon: <UploadIcon uploading={uploading} done={uploadDone} />,
            onClick: handleUploadToggle,
            title: "Upload files to project",
            done: uploadDone,
          },
        ]}
      >
        {/* File explorer tree */}
        <div style={{ overflowY: "auto", overflowX: "hidden", flex: 1 }}>
          <FileExplorer
            cwd={cwd}
            onOpenFile={onOpenFile ?? (() => {})}
            refreshKey={explorerKey}
            onAtMention={onAtMention}
          />
        </div>
      </CollapsibleSection>

      {/* ── Floating file search popup ──────────────────────────── */}
      {fileSearchOpen && searchPopupPos && (
        <div
          ref={fileSearchContainerRef}
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
            overflow: "hidden",
            maxHeight: "min(400px, 60vh)",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {/* Search input */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              height: 32,
              padding: "0 10px",
              borderBottom: "1px solid var(--border)",
              flexShrink: 0,
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
              ref={fileSearchInputRef}
              type="text"
              value={fileSearchQuery}
              onChange={handleFileSearchChange}
              placeholder="Search files by name…"
              aria-label="Search workspace files"
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
            {fileSearchLoading && (
              <span style={{ width: 10, height: 10, flexShrink: 0, color: "var(--text-dim)", fontSize: 10 }}>⋯</span>
            )}
            {fileSearchQuery && !fileSearchLoading && (
              <button
                onClick={() => {
                  setFileSearchQuery("");
                  setFileSearchResults([]);
                  fileSearchInputRef.current?.focus();
                }}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 16, height: 16, padding: 0,
                  background: "none", border: "none",
                  color: "var(--text-dim)", cursor: "pointer", borderRadius: 3,
                }}
                title="Clear search"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>

          {/* Results */}
          <div style={{ overflowY: "auto", flex: 1, maxHeight: "min(340px, 55vh)" }}>
            {fileSearchQuery.trim() && fileSearchResults.length > 0 && (
              fileSearchResults.map((r) => (
                <button
                  key={r.fullPath}
                  onClick={() => {
                    closeFileSearch();
                    if (!r.isDir && onOpenFile) {
                      onOpenFile(r.fullPath, r.name);
                    }
                  }}
                  style={{
                    display: "flex", alignItems: "center", gap: 6,
                    width: "100%", padding: "6px 10px",
                    background: "transparent", border: "none",
                    borderBottom: "1px solid var(--border)",
                    cursor: "pointer", textAlign: "left",
                    transition: "background 0.08s",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                >
                  <span style={{ flexShrink: 0, display: "flex", alignItems: "center", color: "var(--text-dim)" }}>
                    {r.isDir ? (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                      </svg>
                    ) : (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                      </svg>
                    )}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500 }}>
                      {r.name}
                    </div>
                    <div style={{ fontSize: 10, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.relativePath}>
                      {r.relativePath}
                    </div>
                  </div>
                  {!r.isDir && (
                    <span style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}>
                      {r.size > 1024 * 1024 ? (r.size / 1024 / 1024).toFixed(1) + " MB" : r.size > 1024 ? (r.size / 1024).toFixed(0) + " KB" : r.size + " B"}
                    </span>
                  )}
                </button>
              ))
            )}
            {fileSearchQuery.trim() && !fileSearchLoading && fileSearchResults.length === 0 && (
              <div style={{ padding: "12px 10px", fontSize: 11, color: "var(--text-dim)", textAlign: "center" }}>
                No files matching &quot;{fileSearchQuery}&quot;
              </div>
            )}
            {!fileSearchQuery.trim() && (
              <div style={{ padding: "12px 10px", fontSize: 11, color: "var(--text-dim)", textAlign: "center" }}>
                Type to search files in workspace
              </div>
            )}
          </div>

          {/* Footer hint */}
          <div style={{ padding: "4px 10px", fontSize: 9, color: "var(--text-dim)", borderTop: "1px solid var(--border)", flexShrink: 0, fontStyle: "italic" }}>
            Click a file to open it
          </div>
        </div>
      )}

      {/* ── Floating upload popup ──────────────────────────────── */}
      {uploadDirOpen && uploadPopupPos && (
        <div
          ref={uploadDirRef}
          style={{
            position: "fixed",
            top: uploadPopupPos.top,
            left: uploadPopupPos.left,
            width: 200,
            zIndex: 9999,
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            boxShadow: "0 6px 24px rgba(0,0,0,0.18)",
            overflow: "hidden",
            maxHeight: "min(300px, 50vh)",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {/* Breadcrumb */}
          <div style={{ padding: "6px 10px 2px", fontSize: 10, color: "var(--text-dim)", display: "flex", flexWrap: "wrap", gap: 2, rowGap: 0, borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
            {breadcrumbs.length === 0 ? (
              <span style={{ fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase" }}>Upload to Root</span>
            ) : (
              <>
                <button
                  onClick={() => navigateTo("")}
                  style={{ background: "none", border: "none", padding: 0, color: "var(--accent)", cursor: "pointer", fontSize: 10, fontWeight: 600, letterSpacing: "0.05em" }}
                >
                  Root
                </button>
                {breadcrumbs.map((seg, i) => (
                  <span key={i} style={{ display: "flex", alignItems: "center", gap: 2 }}>
                    <span style={{ color: "var(--text-dim)" }}>/</span>
                    {i === breadcrumbs.length - 1 ? (
                      <span style={{ fontWeight: 600, color: "var(--text)", maxWidth: 80, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {seg}
                      </span>
                    ) : (
                      <button
                        onClick={() => navigateTo(breadcrumbs.slice(0, i + 1).join("/"))}
                        style={{ background: "none", border: "none", padding: 0, color: "var(--accent)", cursor: "pointer", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 60 }}
                      >
                        {seg}
                      </button>
                    )}
                  </span>
                ))}
              </>
            )}
          </div>

          {/* Upload here button */}
          <div style={{ padding: "4px 6px", flexShrink: 0 }}>
            <button
              onClick={() => {
                setUploadDir(browsingPath);
                setUploadDirOpen(false);
                setUploadPopupPos(null);
                if (fileInputRef.current) fileInputRef.current.click();
              }}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
                width: "100%", padding: "5px 0",
                background: "rgba(37,99,235,0.08)", border: "1px solid rgba(37,99,235,0.2)",
                borderRadius: 5, color: "var(--accent)", cursor: "pointer", fontSize: 11, fontWeight: 600,
                transition: "background 0.1s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(37,99,235,0.15)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(37,99,235,0.08)"; }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              Upload to{breadcrumbs.length ? " " + breadcrumbs.join("/") : " Root"}
            </button>
          </div>

          {/* Subdirectory list */}
          <div style={{ overflowY: "auto", flex: 1 }}>
            {subdirs.length > 0 && <div style={{ height: 1, background: "var(--border)", margin: "2px 6px" }} />}
            {subdirs.map((d) => (
              <button
                key={d}
                onClick={() => navigateInto(d)}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  width: "100%", padding: "5px 10px",
                  background: "none", border: "none",
                  color: "var(--text-muted)", cursor: "pointer", fontSize: 11, textAlign: "left",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-muted)"; }}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2" />
                </svg>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d}</span>
                <svg width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <polyline points="3 2 7 5 3 8" />
                </svg>
              </button>
            ))}
            {subdirs.length === 0 && breadcrumbs.length > 0 && (
              <div style={{ padding: "10px 10px", fontSize: 10, color: "var(--text-dim)", fontStyle: "italic", textAlign: "center" }}>
                No subdirectories
              </div>
            )}
          </div>

          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={(e) => { void handleUpload(e.target.files); }}
            style={{ display: "none" }}
          />
        </div>
      )}
    </>
  );
}
