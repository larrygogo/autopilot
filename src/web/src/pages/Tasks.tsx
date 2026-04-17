import React, { useEffect, useMemo, useState, useCallback } from "react";
import { api } from "../hooks/useApi";
import { Badge } from "../components/Badge";
import { NewTaskDialog } from "../components/NewTaskDialog";
import { ConfirmDialog } from "../components/Modal";
import { useToast } from "../components/Toast";

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

const TERMINAL_PREFIXES = ["done", "cancelled", "canceled", "failed", "error"];
function isTerminal(status: string): boolean {
  return TERMINAL_PREFIXES.includes(status);
}

export function Tasks({ onSelect, subscribe }: TasksProps) {
  const toast = useToast();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [newOpen, setNewOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusGroup>("all");
  const [workflowFilter, setWorkflowFilter] = useState<string>("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);

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

  const cancellableSelected = useMemo(() => {
    return filtered.filter((t) => selected.has(t.id) && !isTerminal(t.status));
  }, [filtered, selected]);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    const filteredIds = filtered.map((t) => t.id);
    const allSelected = filteredIds.every((id) => selected.has(id));
    setSelected(allSelected
      ? new Set([...selected].filter((id) => !filteredIds.includes(id)))
      : new Set([...selected, ...filteredIds]));
  };

  const clearSelection = () => setSelected(new Set());

  const doBulkCancel = async () => {
    setCancelling(true);
    let ok = 0, fail = 0;
    for (const t of cancellableSelected) {
      try { await api.cancelTask(t.id); ok++; }
      catch { fail++; }
    }
    setCancelling(false);
    setConfirmOpen(false);
    if (fail === 0) toast.success(`已请求取消 ${ok} 个任务`);
    else toast.warning(`请求取消 ${ok} 个任务，${fail} 个失败`);
    clearSelection();
    refresh();
  };

  if (loading) {
    return <div className="container"><p className="muted">加载中...</p></div>;
  }

  const totalMatched = filtered.length;
  const totalAll = tasks.length;
  const allFilteredSelected = filtered.length > 0 && filtered.every((t) => selected.has(t.id));

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

      {selected.size > 0 && (
        <div className="bulk-bar">
          <span><strong>{selected.size}</strong> 个已选 · 可取消 <strong>{cancellableSelected.length}</strong> 个</span>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              className="btn btn-danger"
              onClick={() => setConfirmOpen(true)}
              disabled={cancellableSelected.length === 0}
            >
              批量取消
            </button>
            <button className="btn btn-secondary" onClick={clearSelection}>清除选择</button>
          </div>
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
                  <th style={{ width: 32 }}>
                    <input
                      type="checkbox"
                      aria-label="全选"
                      checked={allFilteredSelected}
                      onChange={toggleSelectAll}
                    />
                  </th>
                  <th>ID</th>
                  <th>标题</th>
                  <th>工作流</th>
                  <th>状态</th>
                  <th>更新时间</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((t) => (
                  <tr key={t.id} style={{ cursor: "pointer" }}>
                    <td onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`选中 ${t.id}`}
                        checked={selected.has(t.id)}
                        onChange={() => toggleSelect(t.id)}
                      />
                    </td>
                    <td className="mono" onClick={() => onSelect(t.id)}>{t.id}</td>
                    <td onClick={() => onSelect(t.id)}>{t.title}</td>
                    <td onClick={() => onSelect(t.id)}>{t.workflow}</td>
                    <td onClick={() => onSelect(t.id)}><Badge status={t.status} /></td>
                    <td className="muted" onClick={() => onSelect(t.id)}>{new Date(t.updated_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 移动端：卡片 */}
          <div className="task-card-list mobile-only">
            {filtered.map((t) => (
              <div
                key={t.id}
                className={`card task-card ${selected.has(t.id) ? "is-selected" : ""}`}
              >
                <div className="task-card-top">
                  <label onClick={(e) => e.stopPropagation()} style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                    <input
                      type="checkbox"
                      checked={selected.has(t.id)}
                      onChange={() => toggleSelect(t.id)}
                    />
                    <span className="mono task-card-id">{t.id}</span>
                  </label>
                  <Badge status={t.status} />
                </div>
                <div className="task-card-title" onClick={() => onSelect(t.id)}>{t.title}</div>
                <div className="task-card-meta" onClick={() => onSelect(t.id)}>
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

      <ConfirmDialog
        open={confirmOpen}
        title="批量取消任务"
        message={
          <div>
            <p>确认取消以下 {cancellableSelected.length} 个任务？正在运行的阶段将被中止。</p>
            <ul style={{ marginTop: "0.5rem", marginLeft: "1rem", fontFamily: "var(--mono)", fontSize: "0.82rem", maxHeight: 220, overflow: "auto" }}>
              {cancellableSelected.map((t) => (
                <li key={t.id}>{t.id} — {t.title}</li>
              ))}
            </ul>
            {selected.size > cancellableSelected.length && (
              <p className="muted" style={{ marginTop: "0.5rem", fontSize: "0.8rem" }}>
                另有 {selected.size - cancellableSelected.length} 个已终态任务会被跳过。
              </p>
            )}
          </div>
        }
        confirmText={cancelling ? "处理中..." : "确认取消"}
        cancelText="不要"
        danger
        onConfirm={doBulkCancel}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
