"use client";

import { useState, useCallback } from "react";

interface Action {
  icon: React.ReactNode;
  onClick: (e: React.MouseEvent) => void;
  title?: string;
  /** Show a coloured active state */
  active?: boolean;
  /** Show a green check briefly after click (e.g. refresh done) */
  done?: boolean;
}

interface Props {
  label: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
  /** Right-side action buttons */
  actions?: Action[];
  /** Whether to auto-hide action buttons when collapsed */
  autoHideActions?: boolean;
  /** Called when collapse/expand state changes */
  onToggle?: (open: boolean) => void;
}

export function CollapsibleSection({
  label,
  defaultOpen = true,
  children,
  actions,
  autoHideActions = true,
  onToggle,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);

  const handleToggle = useCallback(() => {
    setOpen((v) => {
      const next = !v;
      onToggle?.(next);
      return next;
    });
  }, [onToggle]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: open ? "1 1 0" : "0 0 auto",
        minHeight: 0,
        overflow: "hidden",
        borderTop: "1px solid var(--border)",
      }}
    >
      {/* ── Header ──────────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexShrink: 0,
          height: 30,
          userSelect: "none",
        }}
      >
        <button
          onClick={handleToggle}
          title={open ? `Collapse ${label}` : `Expand ${label}`}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            flex: 1,
            height: "100%",
            padding: "0 8px",
            background: "none",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.05em",
            textTransform: "uppercase",
            textAlign: "left",
          }}
        >
          <svg
            width="8"
            height="8"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{
              flexShrink: 0,
              transform: open ? "rotate(90deg)" : "none",
              transition: "transform 0.15s",
            }}
          >
            <polyline points="3 2 7 5 3 8" />
          </svg>
          {label}
        </button>

        {/* Action buttons — hidden when collapsed if autoHideActions */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 2,
            paddingRight: 6,
            opacity: open || !autoHideActions ? 1 : 0,
            pointerEvents: open || !autoHideActions ? "auto" : "none",
            transition: "opacity 0.12s",
          }}
        >
          {actions?.map((action, i) => (
            <button
              key={i}
              onClick={(e) => {
                e.stopPropagation();
                action.onClick(e);
              }}
              title={action.title}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 24,
                height: 24,
                padding: 0,
                background: action.done ? "rgba(74,222,128,0.18)" : action.active ? "rgba(37,99,235,0.10)" : "none",
                border: "none",
                color: action.done ? "#4ade80" : action.active ? "var(--accent)" : "var(--text-dim)",
                cursor: "pointer",
                borderRadius: 5,
                flexShrink: 0,
                transition: "color 0.15s, background 0.15s",
              }}
              onMouseEnter={(e) => {
                if (action.done) return;
                e.currentTarget.style.color = "var(--text-muted)";
                e.currentTarget.style.background = "var(--bg-hover)";
              }}
              onMouseLeave={(e) => {
                if (action.done) return;
                e.currentTarget.style.color = action.active
                  ? "var(--accent)"
                  : "var(--text-dim)";
                e.currentTarget.style.background = action.active
                  ? "rgba(37,99,235,0.10)"
                  : "none";
              }}
            >
              {action.icon}
            </button>
          ))}
        </div>
      </div>

      {/* ── Content — fills remaining flex space when open ────── */}
      <div
        style={{
          flex: open ? "1 1 0" : "0 0 0",
          overflow: "hidden",
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
            overflow: "hidden",
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
