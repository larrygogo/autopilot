import React, { useEffect, useState } from "react";
import { api } from "../hooks/useApi";
import { NewTaskDialog } from "../components/NewTaskDialog";
import { Badge } from "../components/Badge";

interface DaemonStatus {
  version: string;
  uptime: number;
  pid: number;
  taskCounts: Record<string, number>;
}

interface Task {
  id: string;
  title: string;
  workflow: string;
  status: string;
  updated_at: string;
}

// 卡住判定：运行态超过该阈值未更新
const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 min

export function Dashboard({ onSelectTask }: { onSelectTask?: (id: string) => void } = {}) {
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [newOpen, setNewOpen] = useState(false);
  const [diskTotal, setDiskTotal] = useState<number | null>(null);
  const [diskTaskCount, setDiskTaskCount] = useState<number>(0);

  useEffect(() => {
    const refresh = () => {
      api.getStatus().then(setStatus).catch(() => {});
      api.listTasks({ limit: "20" }).then((list) => setTasks(list as Task[])).catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    // 磁盘统计较重，独立周期 60s
    const loadDisk = () => {
      api.getWorkspaceUsage()
        .then((r) => { setDiskTotal(r.total); setDiskTaskCount(r.tasks.filter((t) => t.exists).length); })
        .catch(() => {});
    };
    loadDisk();
    const timer = setInterval(loadDisk, 60000);
    return () => clearInterval(timer);
  }, []);

  if (!status) {
    return <div className="container"><p className="muted">加载中...</p></div>;
  }

  const total = Object.values(status.taskCounts).reduce((a, b) => a + b, 0);
  const done = status.taskCounts["done"] ?? 0;
  const running = Object.entries(status.taskCounts)
    .filter(([k]) => k.startsWith("running_"))
    .reduce((a, [, v]) => a + v, 0);

  const now = Date.now();
  const stale = tasks.filter(
    (t) => t.status.startsWith("running_") && (now - new Date(t.updated_at).getTime() > STALE_THRESHOLD_MS)
  );
  const recent = [...tasks]
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
    .slice(0, 5);

  return (
    <div className="container">
      <div className="page-hdr">
        <h2>Dashboard</h2>
        <span>v{status.version} · PID {status.pid}</span>
        <button className="btn btn-primary" style={{ marginLeft: "auto" }} onClick={() => setNewOpen(true)}>
          新建任务
        </button>
      </div>

      <div className="stats">
        <div className="stat">
          <div className="lbl">总任务数</div>
          <div className="val">{total}</div>
        </div>
        <div className="stat">
          <div className="lbl">运行中</div>
          <div className="val" style={{ color: "#fbbf24" }}>{running}</div>
        </div>
        <div className="stat">
          <div className="lbl">已完成</div>
          <div className="val" style={{ color: "#34d399" }}>{done}</div>
        </div>
      </div>

      {stale.length > 0 && (
        <div className="card alert-card" style={{ marginBottom: "0.75rem" }}>
          <div className="alert-head">
            <strong>⚠ 卡住的任务（{stale.length}）</strong>
            <span className="muted" style={{ fontSize: "0.76rem" }}>超过 30 分钟未更新</span>
          </div>
          <ul className="task-inline-list">
            {stale.map((t) => (
              <li key={t.id} onClick={() => onSelectTask?.(t.id)}>
                <span className="mono">{t.id}</span>
                <span>{t.title}</span>
                <Badge status={t.status} />
                <span className="muted" style={{ fontSize: "0.76rem" }}>
                  {formatAgo(now - new Date(t.updated_at).getTime())}前
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card" style={{ marginBottom: "0.75rem" }}>
        <div className="card-header">
          <h3>最近任务</h3>
          <span className="muted" style={{ fontSize: "0.76rem" }}>最近 5 条</span>
        </div>
        {recent.length === 0 ? (
          <p className="muted">暂无任务</p>
        ) : (
          <ul className="task-inline-list">
            {recent.map((t) => (
              <li key={t.id} onClick={() => onSelectTask?.(t.id)}>
                <span className="mono">{t.id}</span>
                <span className="task-inline-title">{t.title}</span>
                <span className="muted mono" style={{ fontSize: "0.76rem" }}>{t.workflow}</span>
                <Badge status={t.status} />
                <span className="muted" style={{ fontSize: "0.76rem" }}>
                  {new Date(t.updated_at).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {diskTotal !== null && diskTotal > 0 && (
        <div className="card" style={{ marginBottom: "0.75rem" }}>
          <div className="card-header">
            <h3>Workspace 磁盘占用</h3>
            <span className="muted" style={{ fontSize: "0.76rem" }}>
              {diskTaskCount} 个任务目录 · 共 <strong style={{ color: "var(--text)" }}>{formatBytes(diskTotal)}</strong>
            </span>
          </div>
          <p className="muted" style={{ fontSize: "0.78rem" }}>
            单个任务详情页可手动释放；全局 <code className="mono">config.yaml</code> 加 <code className="mono">workspace_retention.days</code> 或 <code className="mono">.max_total_mb</code> 可自动清理终态任务。
          </p>
        </div>
      )}

      {Object.keys(status.taskCounts).length > 0 && (
        <div className="card">
          <h3>状态分布</h3>
          <div style={{ marginTop: "0.75rem" }}>
            {Object.entries(status.taskCounts).map(([state, count]) => (
              <div key={state} style={{ display: "flex", justifyContent: "space-between", padding: "0.25rem 0" }}>
                <span className="mono">{state}</span>
                <span>{count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <NewTaskDialog open={newOpen} onClose={() => setNewOpen(false)} onCreated={(id) => onSelectTask?.(id)} />
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
