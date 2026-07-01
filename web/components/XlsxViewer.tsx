"use client";

import { useEffect, useState } from "react";
import { encodeFilePathForApi, getRelativeFilePath } from "@/lib/file-paths";
import * as XLSX from "xlsx";

interface Props {
  filePath: string;
  cwd?: string;
}

type SheetData = {
  name: string;
  html: string;
  rowCount: number;
};

export default function XlsxViewer({ filePath, cwd }: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sheets, setSheets] = useState<SheetData[]>([]);
  const [activeSheet, setActiveSheet] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSheets([]);
    setActiveSheet(0);

    const encoded = encodeFilePathForApi(filePath);
    fetch(`/api/files/${encoded}?type=read`)
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load file (${r.status})`);
        return r.arrayBuffer();
      })
      .then(async (buffer) => {
        if (cancelled) return;
        const workbook = XLSX.read(new Uint8Array(buffer), { type: "array" });

        // Dynamically import DOMPurify to avoid SSR issues
        let sanitize: (html: string) => string = (h) => h;
        try {
          const mod = await import("dompurify");
          sanitize = mod.default.sanitize;
        } catch (e) {
          // Sanitization is a security control — surface the failure loudly
          // instead of silently falling back to the identity function, which
          // would let any HTML (incl. scripts embedded in cells) through.
          // eslint-disable-next-line no-console
          console.error("[XlsxViewer] dompurify import failed, HTML sanitization disabled — XSS risk:", e);
        }

        const parsed: SheetData[] = workbook.SheetNames.map((name) => {
          const sheet = workbook.Sheets[name];
          const ref = sheet["!ref"];
          const html = sanitize(XLSX.utils.sheet_to_html(sheet, { editable: false }));
          let rowCount = 0;
          if (ref) {
            // Handle multi-range references like "A1:C5,E1:G5" — take max extent
            const ranges = ref.split(",");
            let maxRow = 0;
            for (const range of ranges) {
              const decoded = XLSX.utils.decode_range(range);
              maxRow = Math.max(maxRow, decoded.e.r + 1);
            }
            rowCount = maxRow;
          }
          return { name, html, rowCount };
        });
        if (!cancelled) {
          setSheets(parsed);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [filePath]);

  const currentSheet = sheets[activeSheet];

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
        <span style={{ marginLeft: "auto" }}>xlsx</span>
        {!loading && !error && sheets.length > 0 && (
          <span>
            {sheets.length} sheet{sheets.length > 1 ? "s" : ""}
            {currentSheet && ` · ${currentSheet.rowCount} rows`}
          </span>
        )}
      </div>

      {/* Sheet content */}
      <div style={{ flex: 1, overflow: "auto", background: "var(--bg)" }}>
        {loading && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              minHeight: 200,
              color: "var(--text-dim)",
              fontSize: 13,
            }}
          >
            Loading spreadsheet...
          </div>
        )}
        {error && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              minHeight: 200,
              color: "#f87171",
              fontSize: 13,
              textAlign: "center",
              padding: 24,
            }}
          >
            {error}
          </div>
        )}
        {!loading && !error && currentSheet && (
          <div
            className="xlsx-table"
            style={{ padding: 0 }}
            dangerouslySetInnerHTML={{ __html: currentSheet.html }}
          />
        )}
      </div>

      {/* Sheet tabs */}
      {sheets.length > 1 && (
        <div
          style={{
            display: "flex",
            overflowX: "auto",
            borderTop: "1px solid var(--border)",
            background: "var(--bg-panel)",
            flexShrink: 0,
          }}
        >
          {sheets.map((sheet, i) => (
            <button
              key={sheet.name}
              onClick={() => setActiveSheet(i)}
              style={{
                padding: "4px 14px",
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                border: "none",
                borderRight: "1px solid var(--border)",
                cursor: "pointer",
                whiteSpace: "nowrap",
                background: i === activeSheet ? "var(--bg)" : "transparent",
                color: i === activeSheet ? "var(--text)" : "var(--text-muted)",
                fontWeight: i === activeSheet ? 600 : 400,
                borderTop: i === activeSheet ? "2px solid var(--accent)" : "2px solid transparent",
              }}
            >
              {sheet.name}
              <span style={{ marginLeft: 6, fontSize: 10, color: "var(--text-dim)" }}>
                {sheet.rowCount}r
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
