import React from "react";

const STATUS_STYLES: Record<string, { bg: string; color: string; border: string }> = {
  done: { bg: "rgba(52,211,153,0.1)", color: "#34d399", border: "rgba(52,211,153,0.25)" },
  cancelled: { bg: "rgba(248,113,113,0.1)", color: "#f87171", border: "rgba(248,113,113,0.25)" },
  running: { bg: "rgba(251,191,36,0.1)", color: "#fbbf24", border: "rgba(251,191,36,0.25)" },
  pending: { bg: "rgba(96,165,250,0.1)", color: "#60a5fa", border: "rgba(96,165,250,0.25)" },
  default: { bg: "rgba(160,164,184,0.1)", color: "#a0a4b8", border: "rgba(160,164,184,0.25)" },
};

function getStatusStyle(status: string) {
  if (status === "done") return STATUS_STYLES.done;
  if (status === "cancelled") return STATUS_STYLES.cancelled;
  if (status.startsWith("running")) return STATUS_STYLES.running;
  if (status.startsWith("pending")) return STATUS_STYLES.pending;
  return STATUS_STYLES.default;
}

export function Badge({ status }: { status: string }) {
  const style = getStatusStyle(status);
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 10px",
        borderRadius: "6px",
        fontSize: "0.78rem",
        fontWeight: 600,
        fontFamily: "monospace",
        background: style.bg,
        color: style.color,
        border: `1px solid ${style.border}`,
      }}
    >
      {status}
    </span>
  );
}
