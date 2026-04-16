import React from "react";

interface LogEntry {
  id: number;
  task_id: string;
  from_status: string | null;
  to_status: string;
  trigger_name: string | null;
  note: string | null;
  created_at: string;
}

export function LogTimeline({ logs }: { logs: LogEntry[] }) {
  if (logs.length === 0) {
    return <div style={{ color: "#636882", padding: "1rem" }}>暂无日志</div>;
  }

  return (
    <div style={{ fontFamily: "monospace", fontSize: "0.82rem" }}>
      {logs.map((log) => (
        <div
          key={log.id}
          style={{
            display: "flex",
            gap: "0.75rem",
            padding: "0.35rem 0",
            borderBottom: "1px solid #252838",
          }}
        >
          <span style={{ color: "#636882", whiteSpace: "nowrap" }}>
            {new Date(log.created_at).toLocaleTimeString()}
          </span>
          <span style={{ color: "#60a5fa" }}>
            {log.from_status ?? "—"} → {log.to_status}
          </span>
          {log.trigger_name && (
            <span style={{ color: "#fbbf24" }}>[{log.trigger_name}]</span>
          )}
          {log.note && (
            <span style={{ color: "#a0a4b8" }}>{log.note}</span>
          )}
        </div>
      ))}
    </div>
  );
}
