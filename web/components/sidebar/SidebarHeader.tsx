"use client";

import { useState, useCallback, useRef, useEffect } from "react";

/* ── Scramble animation hook ───────────────────────────────────── */

const SCRAMBLE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";

function useScramble(target: string, running: boolean): string {
  const [display, setDisplay] = useState(target);
  const frameRef = useRef<number | null>(null);
  const iterRef = useRef(0);

  useEffect(() => {
    if (!running) {
      setDisplay(target);
      return;
    }
    iterRef.current = 0;
    const totalFrames = target.length * 4;

    const step = () => {
      iterRef.current += 1;
      const progress = iterRef.current / totalFrames;
      const resolved = Math.floor(progress * target.length);

      setDisplay(
        target
          .split("")
          .map((char, i) => {
            if (char === " ") return " ";
            if (i < resolved) return char;
            return SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
          })
          .join(""),
      );

      if (iterRef.current < totalFrames) {
        frameRef.current = requestAnimationFrame(step);
      } else {
        setDisplay(target);
      }
    };

    frameRef.current = requestAnimationFrame(step);
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, [target, running]);

  return display;
}

/* ── Pi Agent Web title (click to toggle version) ──────────────── */

function PiAgentTitle() {
  const [showVersion, setShowVersion] = useState(false);
  const [scrambling, setScrambling] = useState(false);
  const revertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const target = showVersion
    ? `${process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0"}p${process.env.NEXT_PUBLIC_PI_VERSION ?? "0.0.0"}`
    : "Pi Agent Web";
  const display = useScramble(target, scrambling);

  const scrambleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const triggerScramble = useCallback((toVersion: boolean) => {
    if (scrambleTimerRef.current) clearTimeout(scrambleTimerRef.current);
    setShowVersion(toVersion);
    setScrambling(true);
    scrambleTimerRef.current = setTimeout(() => setScrambling(false), (toVersion ? 6 : 8) * 4 * (1000 / 60) + 100);
  }, []);

  const handleClick = useCallback(() => {
    if (revertTimerRef.current) clearTimeout(revertTimerRef.current);

    const next = !showVersion;
    triggerScramble(next);

    if (next) {
      revertTimerRef.current = setTimeout(() => triggerScramble(false), 3000); // auto-revert after 3s
    }
  }, [showVersion, triggerScramble]);

  useEffect(() => () => {
    if (revertTimerRef.current) clearTimeout(revertTimerRef.current);
    if (scrambleTimerRef.current) clearTimeout(scrambleTimerRef.current);
  }, []);

  return (
    <button
      onClick={handleClick}
      style={{
        background: "none",
        border: "none",
        padding: 0,
        cursor: "default",
        fontWeight: 700,
        fontSize: 15,
        letterSpacing: "-0.01em",
        color: showVersion ? "var(--accent)" : "var(--text)",
        fontFamily: "var(--font-mono)",
        minWidth: "6ch",
      }}
    >
      {display}
    </button>
  );
}

/* ── Props ──────────────────────────────────────────────────────── */

interface Props {
  selectedCwd: string | null;
  onNewSession: () => void;
}

/* ── SidebarHeader component ───────────────────────────────────── */

export function SidebarHeader({ selectedCwd, onNewSession }: Props) {
  return (
    <div
      style={{
        padding: "12px 10px 10px",
        borderBottom: "1px solid var(--border)",
        flexShrink: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 10,
        }}
      >
        <PiAgentTitle />

        <button
          onClick={onNewSession}
          disabled={!selectedCwd}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 5,
            background: "var(--bg-hover)",
            border: "1px solid var(--border)",
            color: selectedCwd ? "var(--text-muted)" : "var(--text-dim)",
            cursor: selectedCwd ? "pointer" : "not-allowed",
            height: 32,
            paddingLeft: 10,
            paddingRight: 12,
            borderRadius: 7,
            fontSize: 12,
            fontWeight: 500,
            letterSpacing: "-0.01em",
            flexShrink: 0,
            transition: "background 0.12s, color 0.12s, border-color 0.12s",
          }}
          title={selectedCwd ? `New session in ${selectedCwd}` : "Select a project first"}
          onMouseEnter={(e) => {
            if (!selectedCwd) return;
            e.currentTarget.style.background = "var(--bg-selected)";
            e.currentTarget.style.color = "var(--accent)";
            e.currentTarget.style.borderColor = "rgba(37,99,235,0.35)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "var(--bg-hover)";
            e.currentTarget.style.color = selectedCwd ? "var(--text-muted)" : "var(--text-dim)";
            e.currentTarget.style.borderColor = "var(--border)";
          }}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
          >
            <line x1="6" y1="1" x2="6" y2="11" />
            <line x1="1" y1="6" x2="11" y2="6" />
          </svg>
          New
        </button>
      </div>
    </div>
  );
}
