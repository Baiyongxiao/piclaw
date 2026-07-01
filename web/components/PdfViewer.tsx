"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { encodeFilePathForApi, getRelativeFilePath, getFileName } from "@/lib/file-paths";

interface Props {
  filePath: string;
  cwd?: string;
  /** URL that returns the PDF bytes (already built by the parent). */
  pdfUrl: string;
  /** Label shown in the status bar, e.g. "pdf" / "pptx". */
  label: string;
  allowDownload?: boolean;
}

interface PdfPage {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function PdfViewer({ filePath, cwd, pdfUrl, label, allowDownload = true }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState(1.2);
  const [size, setSize] = useState<number | null>(null);
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null);
  const pdfDocRef = useRef<unknown>(null);
  // Last pdfUrl rendered into pdfDocRef, so we can detect URL changes inside
  // the render effect and drop the cached document explicitly — rather than
  // relying on a separate effect running first.
  const loadedUrlRef = useRef<string | null>(null);

  // Fetch file metadata for the status bar.
  useEffect(() => {
    const encoded = encodeFilePathForApi(filePath);
    fetch(`/api/files/${encoded}?type=meta`)
      .then((r) => r.json())
      .then((d: { size?: number }) => {
        if (typeof d.size === "number") setSize(d.size);
      })
      .catch(() => { /* non-fatal */ });
  }, [filePath]);

  // Load + render the PDF whenever the URL or scale changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    // Cancel any in-flight render from the previous scale.
    renderTaskRef.current?.cancel();
    renderTaskRef.current = null;

    // If the URL changed (new file / live-reload bust), drop the cached doc
    // so we load the new bytes instead of re-rendering the old one.
    if (loadedUrlRef.current !== pdfUrl) {
      pdfDocRef.current = null;
      loadedUrlRef.current = pdfUrl;
    }

    const container = containerRef.current;
    if (container) container.innerHTML = "";

    (async () => {
      try {
        const pdfjsLib = await import("pdfjs-dist");
        // Worker is served from /public so it works regardless of bundler.
        (pdfjsLib as unknown as { GlobalWorkerOptions: { workerSrc: string } }).GlobalWorkerOptions.workerSrc =
          "/pdf.worker.min.mjs";

        // If we already have the document loaded, just re-render at new scale.
        let pdf = pdfDocRef.current as {
          numPages: number;
          getPage: (n: number) => Promise<{
            getViewport: (o: { scale: number }) => { width: number; height: number };
            render: (o: { canvasContext: CanvasRenderingContext2D; viewport: unknown }) => { promise: Promise<void>; cancel: () => void };
          }>;
        } | null;

        if (!pdf) {
          const loadingTask = (pdfjsLib as unknown as {
            getDocument: (src: { url: string }) => { promise: Promise<typeof pdf> };
          }).getDocument({ url: pdfUrl });
          pdf = await loadingTask.promise;
          if (cancelled) return;
          pdfDocRef.current = pdf;
          if (pdf) setNumPages(pdf.numPages);
        }

        if (cancelled || !container || !pdf) return;
        const doc = pdf;

        for (let i = 1; i <= doc.numPages; i++) {
          if (cancelled) return;
          const page = await doc.getPage(i);
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement("canvas");
          const ctx = canvas.getContext("2d");
          if (!ctx) continue;
          const dpr = window.devicePixelRatio || 1;
          canvas.width = Math.floor(viewport.width * dpr);
          canvas.height = Math.floor(viewport.height * dpr);
          canvas.style.width = `${Math.floor(viewport.width)}px`;
          canvas.style.height = `${Math.floor(viewport.height)}px`;
          canvas.style.display = "block";
          canvas.style.margin = "0 auto 16px";
          canvas.style.boxShadow = "0 2px 10px rgba(0,0,0,0.18)";
          canvas.style.background = "#fff";

          const renderTask = page.render({
            canvasContext: ctx,
            viewport,
            transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
          } as never);
          renderTaskRef.current = { cancel: () => renderTask.cancel() };
          await renderTask.promise;
          if (cancelled) return;
          container.appendChild(canvas);
        }
        if (!cancelled) setLoading(false);
      } catch (e) {
        if (cancelled) return;
        // pdfjs-dist throws RenderingCancelledException when a render is
        // aborted (e.g. zoom change). Match that specifically — a broad
        // /cancel/i would also swallow genuine "download cancelled" errors.
        const msg = e instanceof Error ? e.message : String(e);
        if (/RenderingCancelled/i.test(msg)) return;
        setError(msg || "Failed to render PDF");
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfUrl, scale]);

  const zoomIn = useCallback(() => setScale((s) => Math.min(s + 0.25, 4)), []);
  const zoomOut = useCallback(() => setScale((s) => Math.max(s - 0.25, 0.4)), []);

  const encoded = encodeFilePathForApi(filePath);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Status bar */}
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
        <span style={{ marginLeft: "auto" }}>{label}</span>
        {numPages > 0 && <span>{numPages} page{numPages > 1 ? "s" : ""}</span>}
        {size != null && <span>{formatSize(size)}</span>}
        {allowDownload && (
          <a
            href={`/api/files/${encoded}?type=read`}
            download={getFileName(filePath)}
            style={{
              color: "var(--text-muted)",
              textDecoration: "none",
              border: "1px solid var(--border)",
              borderRadius: 5,
              padding: "2px 8px",
              fontSize: 11,
              lineHeight: 1.4,
              background: "var(--bg-hover)",
              flexShrink: 0,
            }}
          >
            Download
          </a>
        )}
        {/* Zoom controls */}
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

      {/* Render area — the canvas container is React-empty; pdf.js appends
          <canvas> nodes directly into it. Loading/error are absolutely
          positioned siblings so React never reconciles against the canvas
          nodes (which it didn't create). */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          position: "relative",
          overflow: "auto",
          background: "var(--bg-panel)",
        }}
      >
        {/* pdf.js render target — React never touches children here. */}
        <div ref={containerRef} style={{ minHeight: "100%", padding: "16px 0" }} />
        {loading && !error && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              minHeight: 200,
              color: "var(--text-dim)",
              fontSize: 13,
              background: "var(--bg-panel)",
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
              minHeight: 200,
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
