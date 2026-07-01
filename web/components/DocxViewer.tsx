"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { encodeFilePathForApi, getRelativeFilePath } from "@/lib/file-paths";

interface Props {
  filePath: string;
  cwd?: string;
}

export default function DocxViewer({ filePath, cwd }: Props) {
  // docx-preview writes DOM nodes directly into `containerRef`. React must NOT
  // also manage children inside that same node — otherwise on the next render
  // (e.g. setLoading(false)) React reconciles against a DOM it doesn't expect
  // and throws "Failed to execute 'removeChild'", crashing the whole tree.
  // So the container stays empty (no React children); loading/error are
  // rendered as absolutely-positioned siblings overlaid on top of it.
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(1.2);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const encoded = encodeFilePathForApi(filePath);
    fetch(`/api/files/${encoded}?type=read`)
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load file (${r.status})`);
        return r.arrayBuffer();
      })
      .then(async (buffer) => {
        if (cancelled || !containerRef.current) return;
        // Clear any previous render before importing (also guards re-runs).
        containerRef.current.innerHTML = "";
        const { renderAsync } = await import("docx-preview");
        // docx-preview accepts a Blob or ArrayBuffer; Blob is the most broadly
        // compatible input shape across docx-preview versions.
        const blob = new Blob([buffer], {
          type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        });
        await renderAsync(blob, containerRef.current, undefined, {
          className: "docx-viewer",
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: false,
          ignoreFonts: false,
          breakPages: true,
          ignoreLastRenderedPageBreak: true,
          experimental: false,
          trimXmlDeclaration: true,
          useBase64URL: true,
          renderChanges: false,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
        });
        if (!cancelled) setLoading(false);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e?.message ? String(e.message) : "Failed to render document");
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [filePath]);

  const zoomIn = useCallback(() => setScale((s) => Math.min(s + 0.25, 4)), []);
  const zoomOut = useCallback(() => setScale((s) => Math.max(s - 0.25, 0.4)), []);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "4px 16px",
          borderBottom: "1px solid var(--border)",
          fontSize: 11,
          color: "var(--text-dim)",
          background: "var(--bg)",
          flexShrink: 0,
        }}
      >
        <span
          style={{ fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          title={filePath}
        >
          {getRelativeFilePath(filePath, cwd)}
        </span>
        <span style={{ marginLeft: "auto" }}>docx</span>
        {/* Zoom controls — same style as PdfViewer */}
        <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
          <button
            onClick={zoomOut}
            title="Zoom out"
            style={{
              width: 22, height: 22, fontSize: 14, lineHeight: 1, cursor: "pointer",
              background: "var(--bg-hover)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 5,
            }}
          >−</button>
          <span style={{ minWidth: 34, textAlign: "center", fontFamily: "var(--font-mono)" }}>
            {Math.round(scale * 100)}%
          </span>
          <button
            onClick={zoomIn}
            title="Zoom in"
            style={{
              width: 22, height: 22, fontSize: 14, lineHeight: 1, cursor: "pointer",
              background: "var(--bg-hover)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 5,
            }}
          >+</button>
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, position: "relative", background: "#eef1f5", overflow: "auto" }}>
        {/* Scale wrapper — width compensation ensures the scroll container's
            layout size matches the visual content after transform, preventing
            clipping on zoom-in or excessive whitespace on zoom-out. */}
        <div style={{ width: `${100 / scale}%` }}>
          <div style={{ transform: `scale(${scale})`, transformOrigin: "top left" }}>
            {/* docx-preview render target — React never touches children here. */}
            <div ref={containerRef} className="docx-viewer" />
          </div>
        </div>
        {loading && !error && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--text-dim)",
              fontSize: 13,
              background: "#eef1f5",
            }}
          >
            Loading document...
          </div>
        )}
        {error && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#f87171",
              fontSize: 13,
              textAlign: "center",
              padding: 24,
              background: "var(--bg)",
            }}
          >
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
