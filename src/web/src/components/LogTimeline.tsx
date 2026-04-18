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
    return <div className="px-3 py-4 text-sm text-muted-foreground">暂无日志</div>;
  }

  return (
    <div className="divide-y divide-border font-mono text-xs">
      {logs.map((log) => (
        <div key={log.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 break-words py-1.5">
          <span className="whitespace-nowrap text-muted-foreground">
            {new Date(log.created_at).toLocaleTimeString()}
          </span>
          <span className="text-info">
            {log.from_status ?? "—"} → {log.to_status}
          </span>
          {log.trigger_name && (
            <span className="text-warning">[{log.trigger_name}]</span>
          )}
          {log.note && <span className="text-muted-foreground">{log.note}</span>}
        </div>
      ))}
    </div>
  );
}
