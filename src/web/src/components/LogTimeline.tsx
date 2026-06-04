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

/**
 * 蓝图风时间轴：
 * - 左侧 1px 虚线时间轴 + 每行节点圆点（accent 色）
 * - mono + 字距，像工程图的时序注记
 */
export function LogTimeline({ logs }: { logs: LogEntry[] }) {
  if (logs.length === 0) {
    return (
      <div className="px-3 py-4 text-xs text-muted-foreground">
        暂无日志 · NO ENTRIES
      </div>
    );
  }

  return (
    <div className="relative pl-6 font-mono text-xs">
      {/* 左侧时间轴线（虚线） */}
      <div
        className="absolute left-2 top-2 bottom-2 w-px border-l border-border"
        aria-hidden="true"
      />
      {logs.map((log, i) => (
        <div
          key={log.id}
          className={
            "relative flex flex-wrap items-baseline gap-x-3 gap-y-1 break-words py-1.5 " +
            (i !== logs.length - 1 ? "border-b border-border" : "")
          }
        >
          {/* 节点圆点 */}
          <span
            className="absolute -left-[18px] top-2.5 h-1.5 w-1.5 rounded-full bg-accent"
            aria-hidden="true"
          />
          <span className="whitespace-nowrap text-muted-foreground">
            {new Date(log.created_at).toLocaleTimeString()}
          </span>
          <span className="text-info">
            {log.from_status ?? "—"} <span className="opacity-50">→</span> {log.to_status}
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
