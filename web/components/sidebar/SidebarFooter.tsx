"use client";

interface Props {
  hasCwd: boolean;
  onOpenModels: () => void;
  onOpenSkills: () => void;
}

export function SidebarFooter({ hasCwd, onOpenModels, onOpenSkills }: Props) {
  const buttons = [
    {
      label: "Models",
      onClick: onOpenModels,
      disabled: false,
      icon: (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <rect x="9" y="9" width="6" height="6" />
          <line x1="9" y1="1" x2="9" y2="4" />
          <line x1="15" y1="1" x2="15" y2="4" />
          <line x1="9" y1="20" x2="9" y2="23" />
          <line x1="15" y1="20" x2="15" y2="23" />
          <line x1="20" y1="9" x2="23" y2="9" />
          <line x1="20" y1="14" x2="23" y2="14" />
          <line x1="1" y1="9" x2="4" y2="9" />
          <line x1="1" y1="14" x2="4" y2="14" />
        </svg>
      ),
    },
    {
      label: "Skills",
      onClick: onOpenSkills,
      disabled: !hasCwd,
      icon: (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 2L2 7l10 5 10-5-10-5z" />
          <path d="M2 17l10 5 10-5" />
          <path d="M2 12l10 5 10-5" />
        </svg>
      ),
    },
  ] as const;

  return (
    <div
      style={{
        padding: "8px",
        flexShrink: 0,
        display: "flex",
        justifyContent: "space-between",
        gap: 4,
        borderTop: "1px solid var(--border)",
        marginTop: "auto",
      }}
    >
      {buttons.map(({ label, onClick, disabled, icon }) => (
        <button
          key={label}
          onClick={onClick}
          disabled={disabled}
          title={label}
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            height: 32,
            padding: 0,
            background: "none",
            border: "none",
            borderRadius: 9,
            color: "var(--text-muted)",
            cursor: disabled ? "default" : "pointer",
            fontSize: 12,
            opacity: disabled ? 0.35 : 1,
            transition: "background 0.12s, color 0.12s",
          }}
          onMouseEnter={(e) => {
            if (!disabled) {
              e.currentTarget.style.background = "var(--bg-hover)";
              e.currentTarget.style.color = "var(--text)";
            }
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "none";
            e.currentTarget.style.color = "var(--text-muted)";
          }}
        >
          {icon}
          {label}
        </button>
      ))}
    </div>
  );
}
