import React, { useEffect, useState } from "react";
import { api } from "../hooks/useApi";

interface DaemonStatus {
  version: string;
  uptime: number;
  pid: number;
  taskCounts: Record<string, number>;
}

export function Dashboard() {
  const [status, setStatus] = useState<DaemonStatus | null>(null);

  useEffect(() => {
    api.getStatus().then(setStatus).catch(() => {});
    const timer = setInterval(() => {
      api.getStatus().then(setStatus).catch(() => {});
    }, 5000);
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

  const formatUptime = (s: number) => {
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  };

  return (
    <div className="container">
      <div className="page-hdr">
        <h2>Dashboard</h2>
        <span>v{status.version} · PID {status.pid}</span>
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

      <div className="card">
        <h3>运行信息</h3>
        <div className="info-grid" style={{ marginTop: "0.75rem" }}>
          <div><span className="muted">运行时间：</span>{formatUptime(status.uptime)}</div>
          <div><span className="muted">PID：</span>{status.pid}</div>
          <div><span className="muted">版本：</span>{status.version}</div>
        </div>
      </div>

      {Object.keys(status.taskCounts).length > 0 && (
        <div className="card" style={{ marginTop: "0.75rem" }}>
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
    </div>
  );
}
