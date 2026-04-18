import React, { useEffect, useState } from "react";
import { AlertTriangle, Activity, CheckCircle2, Database, ListTodo, Skull } from "lucide-react";
import { api } from "@/hooks/useApi";
import { cn } from "@/lib/utils";

interface Task {
  id: string;
  title: string;
  workflow: string;
  status: string;
  updated_at: string;
  dangling?: boolean;
}

interface DaemonStatus {
  version: string;
  uptime: number;
  pid: number;
  taskCounts: Record<string, number>;
}

const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 min

export function TasksOverview({
  tasks,
  onSelectTask,
}: {
  tasks: Task[];
  onSelectTask: (id: string) => void;
}) {
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [diskTotal, setDiskTotal] = useState<number | null>(null);
  const [diskTaskCount, setDiskTaskCount] = useState(0);

  useEffect(() => {
    const fetchStatus = () => api.getStatus().then(setStatus).catch(() => {});
    fetchStatus();
    const t = setInterval(fetchStatus, 5000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const loadDisk = () => {
      api
        .getWorkspaceUsage()
        .then((r) => {
          setDiskTotal(r.total);
          setDiskTaskCount(r.tasks.filter((t) => t.exists).length);
        })
        .catch(() => {});
    };
    loadDisk();
    const t = setInterval(loadDisk, 60000);
    return () => clearInterval(t);
  }, []);

  const total = status ? Object.values(status.taskCounts).reduce((a, b) => a + b, 0) : 0;
  const done = status ? status.taskCounts["done"] ?? 0 : 0;
  const running = status
    ? Object.entries(status.taskCounts)
        .filter(([k]) => k.startsWith("running_"))
        .reduce((a, [, v]) => a + v, 0)
    : 0;

  const now = Date.now();
  const stale = tasks.filter(
    (t) => t.status.startsWith("running_") && now - new Date(t.updated_at).getTime() > STALE_THRESHOLD_MS,
  );
  const dangling = tasks.filter(
    (t) => !!t.dangling && t.status.startsWith("running_"),
  );

  return (
    <div className="mb-6 space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="总任务" value={total} icon={ListTodo} />
        <Stat label="运行中" value={running} icon={Activity} tone="warning" />
        <Stat label="已完成" value={done} icon={CheckCircle2} tone="success" />
        <Stat label="卡住" value={stale.length} icon={AlertTriangle} tone={stale.length > 0 ? "destructive" : "muted"} />
        <Stat label="失效" value={dangling.length} icon={Skull} tone={dangling.length > 0 ? "destructive" : "muted"} />
      </div>

      {dangling.length > 0 && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <div className="mb-2 flex items-center gap-2 font-medium text-destructive">
            <Skull className="h-4 w-4" />
            <span>{dangling.length} 个任务失效（daemon 重启时 agent 进程已死）</span>
          </div>
          <ul className="space-y-1">
            {dangling.slice(0, 5).map((t) => (
              <li
                key={t.id}
                onClick={() => onSelectTask(t.id)}
                className="flex cursor-pointer items-center gap-3 rounded px-2 py-1 text-xs hover:bg-destructive/10"
              >
                <span className="font-mono text-muted-foreground">{t.id}</span>
                <span className="truncate">{t.title}</span>
                <span className="ml-auto text-muted-foreground">点击进入并取消</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {stale.length > 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
          <div className="mb-2 flex items-center gap-2 font-medium text-amber-600 dark:text-amber-400">
            <AlertTriangle className="h-4 w-4" />
            <span>{stale.length} 个任务超过 30 分钟未更新</span>
          </div>
          <ul className="space-y-1">
            {stale.slice(0, 5).map((t) => (
              <li
                key={t.id}
                onClick={() => onSelectTask(t.id)}
                className="flex cursor-pointer items-center gap-3 rounded px-2 py-1 text-xs hover:bg-amber-500/10"
              >
                <span className="font-mono text-muted-foreground">{t.id}</span>
                <span className="truncate">{t.title}</span>
                <span className="ml-auto text-muted-foreground">
                  {formatAgo(now - new Date(t.updated_at).getTime())}前
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {diskTotal !== null && diskTotal > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2 text-xs text-muted-foreground">
          <Database className="h-3.5 w-3.5" />
          <span>
            {diskTaskCount} 个 workspace · 共 <strong className="text-foreground">{formatBytes(diskTotal)}</strong>
          </span>
          <span className="ml-auto text-[11px]">
            配置 <code className="font-mono text-foreground">config.yaml</code> 的{" "}
            <code className="font-mono">workspace_retention</code> 自动清理
          </span>
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  icon: Icon,
  tone = "default",
}: {
  label: string;
  value: number;
  icon: React.ComponentType<{ className?: string }>;
  tone?: "default" | "success" | "warning" | "destructive" | "muted";
}) {
  const toneClass = {
    default: "text-foreground",
    success: "text-emerald-600 dark:text-emerald-400",
    warning: "text-amber-600 dark:text-amber-400",
    destructive: "text-rose-600 dark:text-rose-400",
    muted: "text-muted-foreground",
  }[tone];

  return (
    <div className="rounded-lg border bg-card px-4 py-3.5 shadow-sm transition-colors hover:bg-accent/30">
      <div className="flex items-center justify-between text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        <span>{label}</span>
        <Icon className={cn("h-3.5 w-3.5", toneClass)} />
      </div>
      <div className={cn("mt-1 font-mono text-2xl font-semibold tabular-nums", toneClass)}>{value}</div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatAgo(ms: number): string {
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h${min % 60 ? ` ${min % 60}m` : ""}`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}
