import React from "react";
import { EmptyState } from "@/components/pro";
import { taskStatusZh, taskTriggerZh } from "@/lib/run-view-logic";

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
 * 状态机日志时间轴：
 * - 左侧 1px 虚线时间轴 + 每行节点圆点（accent 色）
 * - 状态/trigger 显示中文（业务标签），hover title 露出内核名（叠加不替换）
 */
export function LogTimeline({ logs, phaseLabelOf }: { logs: LogEntry[]; phaseLabelOf?: (phase: string) => string }) {
  const labelOf = phaseLabelOf ?? ((p: string) => p);
  if (logs.length === 0) {
    return <EmptyState size="inline" title="暂无状态转移记录" />;
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
          <span className="text-info" title={`${log.from_status ?? "—"} → ${log.to_status}`}>
            {log.from_status ? taskStatusZh(log.from_status, labelOf) : "—"}
            {" "}<span className="opacity-50">→</span>{" "}
            {taskStatusZh(log.to_status, labelOf)}
          </span>
          {log.trigger_name && (
            <span className="text-warning" title={`trigger: ${log.trigger_name}`}>
              [{taskTriggerZh(log.trigger_name, labelOf)}]
            </span>
          )}
          {/* break-all：note 里的长 URL（如 PR 链接）无空格可断，flex 子项的 min-content
              会撑出横向溢出（break-words 不缩 min-content，移动端实测溢出屏幕） */}
          {log.note && <span className="min-w-0 break-all text-muted-foreground">{log.note}</span>}
        </div>
      ))}
    </div>
  );
}
