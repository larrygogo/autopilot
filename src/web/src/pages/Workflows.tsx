import React, { useEffect, useState } from "react";
import { api } from "../hooks/useApi";
import { StateMachineGraph } from "../components/StateMachineGraph";

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
  const [workflows, setWorkflows] = useState<WorkflowInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  useEffect(() => {
    api.listWorkflows()
      .then(setWorkflows)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

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
      </div>

      {workflows.length === 0 ? (
        <div className="card empty-state">
          <p className="muted">暂无已注册工作流</p>
          <p className="muted" style={{ fontSize: "0.78rem" }}>
            在 <code className="mono">AUTOPILOT_HOME/workflows/</code> 下添加工作流目录即可
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
              <button className="btn btn-secondary" onClick={() => setSelected(null)}>
                收起
              </button>
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
    </div>
  );
}
