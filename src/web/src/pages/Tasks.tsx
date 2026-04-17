import React, { useEffect, useMemo, useState, useCallback } from "react";
import { api } from "../hooks/useApi";
import { Badge } from "../components/Badge";
import { NewTaskDialog } from "../components/NewTaskDialog";

interface Task {
  id: string;
  title: string;
  workflow: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface TasksProps {
  onSelect: (id: string) => void;
  subscribe: (channel: string, handler: (event: any) => void) => () => void;
}

type StatusGroup = "all" | "running" | "pending" | "done" | "cancelled" | "failed";

const STATUS_GROUPS: { key: StatusGroup; label: string; match: (s: string) => boolean }[] = [
  { key: "all", label: "全部", match: () => true },
  { key: "running", label: "运行中", match: (s) => s.startsWith("running_") },
  { key: "pending", label: "待处理", match: (s) => s.startsWith("pending_") },
  { key: "done", label: "已完成", match: (s) => s === "done" },
  { key: "cancelled", label: "已取消", match: (s) => s === "cancelled" || s === "canceled" },
  { key: "failed", label: "失败", match: (s) => s === "failed" || s === "error" },
];

export function Tasks({ onSelect, subscribe }: TasksProps) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [newOpen, setNewOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusGroup>("all");
  const [workflowFilter, setWorkflowFilter] = useState<string>("");

  const refresh = useCallback(() => {
    api.listTasks().then(setTasks).catch(() => {}).finally(() => setLoading(false));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    return subscribe("task:*", () => {
      refresh();
    });
  }, [subscribe, refresh]);

  const workflowOptions = useMemo(() => {
    const set = new Set<string>();
    for (const t of tasks) set.add(t.workflow);
    return [...set].sort();
  }, [tasks]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const statusMatch = STATUS_GROUPS.find((g) => g.key === statusFilter)!.match;
    return tasks.filter((t) => {
      if (!statusMatch(t.status)) return false;
      if (workflowFilter && t.workflow !== workflowFilter) return false;
      if (q && !t.id.toLowerCase().includes(q) && !t.title.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [tasks, search, statusFilter, workflowFilter]);

  if (loading) {
    return <div className="container"><p className="muted">加载中...</p></div>;
  }

  const totalMatched = filtered.length;
  const totalAll = tasks.length;

  return (
    <div className="container">
      <div className="page-hdr">
        <h2>任务列表</h2>
        <span>{totalMatched === totalAll ? `${totalAll} 个` : `${totalMatched} / ${totalAll}`}</span>
        <button className="btn btn-primary" style={{ marginLeft: "auto" }} onClick={() => setNewOpen(true)}>
          新建任务
        </button>
      </div>

      {totalAll > 0 && (
        <div className="filter-bar">
          <input
            type="search"
            className="text-input"
            placeholder="搜索 ID 或标题..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="filter-chips">
            {STATUS_GROUPS.map((g) => (
              <button
                key={g.key}
                type="button"
                className={`chip ${statusFilter === g.key ? "active" : ""}`}
                onClick={() => setStatusFilter(g.key)}
              >
                {g.label}
              </button>
            ))}
          </div>
          {workflowOptions.length > 1 && (
            <select
              className="wf-select filter-wf"
              value={workflowFilter}
              onChange={(e) => setWorkflowFilter(e.target.value)}
            >
              <option value="">所有工作流</option>
              {workflowOptions.map((w) => <option key={w} value={w}>{w}</option>)}
            </select>
          )}
        </div>
      )}

      {totalAll === 0 ? (
        <div className="card empty-state">
          <p className="muted">暂无任务</p>
          <button className="btn btn-primary" onClick={() => setNewOpen(true)}>创建第一个任务</button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="card empty-state">
          <p className="muted">没有匹配的任务</p>
          <button className="btn btn-secondary" onClick={() => { setSearch(""); setStatusFilter("all"); setWorkflowFilter(""); }}>
            清除过滤
          </button>
        </div>
      ) : (
        <>
          {/* 桌面端：表格 */}
          <div className="table-wrap desktop-only">
            <table className="task-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>标题</th>
                  <th>工作流</th>
                  <th>状态</th>
                  <th>更新时间</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((t) => (
                  <tr key={t.id} onClick={() => onSelect(t.id)} style={{ cursor: "pointer" }}>
                    <td className="mono">{t.id}</td>
                    <td>{t.title}</td>
                    <td>{t.workflow}</td>
                    <td><Badge status={t.status} /></td>
                    <td className="muted">{new Date(t.updated_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 移动端：卡片 */}
          <div className="task-card-list mobile-only">
            {filtered.map((t) => (
              <div key={t.id} className="card task-card" onClick={() => onSelect(t.id)}>
                <div className="task-card-top">
                  <span className="mono task-card-id">{t.id}</span>
                  <Badge status={t.status} />
                </div>
                <div className="task-card-title">{t.title}</div>
                <div className="task-card-meta">
                  <span className="mono muted">{t.workflow}</span>
                  <span className="muted">{new Date(t.updated_at).toLocaleString()}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <NewTaskDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreated={(id) => { refresh(); onSelect(id); }}
      />
    </div>
  );
}
