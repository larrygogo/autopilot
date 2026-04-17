import React, { useEffect, useState } from "react";
import { api } from "../hooks/useApi";
import { StateMachineGraph } from "../components/StateMachineGraph";
import { NewWorkflowDialog } from "../components/NewWorkflowDialog";
import { ConfirmDialog } from "../components/Modal";
import { useToast } from "../components/Toast";

interface WorkflowInfo {
  name: string;
  description: string;
}

interface WorkflowDetail {
  name: string;
  description?: string;
  agents?: Array<{ name: string; extends?: string; provider?: string; model?: string }>;
  phases?: unknown[];
  initial_state?: string;
  terminal_states?: string[];
  [key: string]: unknown;
}

interface Selected {
  name: string;
  detail: WorkflowDetail;
  graph: any;
}

interface Props {
  onJumpToAgent?: (name: string) => void;
}

export function Workflows({ onJumpToAgent }: Props = {}) {
  const toast = useToast();
  const [workflows, setWorkflows] = useState<WorkflowInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const refresh = () => {
    setLoading(true);
    api.listWorkflows()
      .then(setWorkflows)
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { refresh(); }, []);

  const toggle = async (name: string) => {
    if (selected?.name === name) {
      setSelected(null);
      return;
    }
    setLoadingDetail(true);
    try {
      const [detail, graph] = await Promise.all([
        api.getWorkflow(name),
        api.getWorkflowGraph(name),
      ]);
      setSelected({ name, detail, graph });
    } catch { /* ignore */ } finally {
      setLoadingDetail(false);
    }
  };

  if (loading) {
    return <div className="container"><p className="muted">加载中...</p></div>;
  }

  return (
    <div className="container">
      <div className="page-hdr">
        <h2>工作流</h2>
        <span>{workflows.length} 个</span>
        <button className="btn btn-primary" style={{ marginLeft: "auto" }} onClick={() => setNewOpen(true)}>
          新建工作流
        </button>
      </div>

      {workflows.length === 0 ? (
        <div className="card empty-state">
          <p className="muted">暂无已注册工作流</p>
          <button className="btn btn-primary" onClick={() => setNewOpen(true)}>创建第一个工作流</button>
          <p className="muted" style={{ fontSize: "0.78rem" }}>
            或手动在 <code className="mono">AUTOPILOT_HOME/workflows/</code> 下添加目录
          </p>
        </div>
      ) : (
        <div className="workflow-grid">
          {workflows.map((wf) => {
            const active = selected?.name === wf.name;
            return (
              <div
                key={wf.name}
                className={`card workflow-card ${active ? "active" : ""}`}
                onClick={() => toggle(wf.name)}
              >
                <h3 style={{ color: "#22d3ee" }}>{wf.name}</h3>
                {wf.description && <p className="muted">{wf.description}</p>}
                <p className="muted" style={{ fontSize: "0.75rem", marginTop: "0.5rem" }}>
                  {active ? "▼ 点击收起" : "▶ 点击查看详情"}
                </p>
              </div>
            );
          })}
        </div>
      )}

      {loadingDetail && (
        <p className="muted" style={{ marginTop: "1rem" }}>加载详情中...</p>
      )}

      {selected && !loadingDetail && (
        <>
          <div className="card" style={{ marginTop: "1rem" }}>
            <div className="card-header">
              <h3>{selected.name}</h3>
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <button className="btn btn-danger" onClick={() => setPendingDelete(selected.name)}>
                  删除
                </button>
                <button className="btn btn-secondary" onClick={() => setSelected(null)}>
                  收起
                </button>
              </div>
            </div>
            {selected.detail.description && (
              <p className="muted" style={{ marginBottom: "0.75rem" }}>{selected.detail.description}</p>
            )}

            <div className="info-grid">
              <div><span className="muted">初始状态：</span><span className="mono">{selected.detail.initial_state}</span></div>
              <div><span className="muted">终态数：</span>{selected.detail.terminal_states?.length ?? 0}</div>
              <div><span className="muted">阶段数：</span>{selected.detail.phases?.length ?? 0}</div>
              <div><span className="muted">智能体数：</span>{selected.detail.agents?.length ?? 0}</div>
            </div>
          </div>

          {selected.detail.agents && selected.detail.agents.length > 0 && (
            <div className="card" style={{ marginTop: "0.75rem" }}>
              <div className="card-header">
                <h3>使用的智能体</h3>
                <span className="muted" style={{ fontSize: "0.76rem" }}>
                  点击跳转到智能体编辑
                </span>
              </div>
              <div className="agent-list">
                {selected.detail.agents.map((a, i) => {
                  const baseName = a.extends ?? a.name;
                  return (
                    <div
                      key={i}
                      className="card agent-card"
                      style={{ cursor: onJumpToAgent ? "pointer" : "default" }}
                      onClick={() => onJumpToAgent?.(baseName)}
                    >
                      <div className="agent-card-head">
                        <div>
                          <h3 className="mono" style={{ color: "var(--cyan)" }}>{a.name}</h3>
                          <div className="agent-meta mono muted">
                            {a.extends && <span>继承自 {a.extends}</span>}
                            {a.provider && <span>· {a.provider}</span>}
                            {a.model && <span>/ {a.model}</span>}
                          </div>
                        </div>
                        {onJumpToAgent && <span className="muted">→</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="card" style={{ marginTop: "0.75rem" }}>
            <h3>状态机</h3>
            <div className="graph-wrap">
              <StateMachineGraph
                nodes={selected.graph.nodes}
                edges={selected.graph.edges}
              />
            </div>
          </div>
        </>
      )}

      <NewWorkflowDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreated={() => refresh()}
      />

      <ConfirmDialog
        open={!!pendingDelete}
        title="删除工作流"
        message={
          <div>
            <p>确认删除工作流 <code className="mono">{pendingDelete}</code>？</p>
            <div style={{ marginTop: "0.75rem", padding: "0.6rem 0.8rem", background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.25)", borderRadius: 6 }}>
              <p style={{ color: "var(--red)", fontSize: "0.82rem" }}>
                ⚠ 将永久删除整个目录：<br />
                <code className="mono">AUTOPILOT_HOME/workflows/{pendingDelete}/</code>
              </p>
              <p className="muted" style={{ marginTop: "0.4rem", fontSize: "0.78rem" }}>
                包括 workflow.yaml、workflow.ts 及该目录内的所有文件。此操作不可恢复。
              </p>
            </div>
          </div>
        }
        confirmText="删除"
        danger
        onConfirm={async () => {
          if (!pendingDelete) return;
          const name = pendingDelete;
          try {
            await api.deleteWorkflow(name);
            toast.success(`工作流 ${name} 已删除`);
            setSelected(null);
            refresh();
          } catch (e: any) {
            toast.error("删除失败", e?.message ?? String(e));
          } finally {
            setPendingDelete(null);
          }
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
