import React, { useEffect, useState } from "react";
import { api } from "../hooks/useApi";
import { StateMachineGraph } from "../components/StateMachineGraph";

interface WorkflowInfo {
  name: string;
  description: string;
}

export function Workflows() {
  const [workflows, setWorkflows] = useState<WorkflowInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedGraph, setSelectedGraph] = useState<{ name: string; data: any } | null>(null);

  useEffect(() => {
    api.listWorkflows()
      .then(setWorkflows)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const loadGraph = async (name: string) => {
    if (selectedGraph?.name === name) {
      setSelectedGraph(null);
      return;
    }
    try {
      const data = await api.getWorkflowGraph(name);
      setSelectedGraph({ name, data });
    } catch { /* ignore */ }
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
        <div className="card"><p className="muted">暂无已注册工作流</p></div>
      ) : (
        <div className="workflow-grid">
          {workflows.map((wf) => (
            <div key={wf.name} className="card workflow-card" onClick={() => loadGraph(wf.name)}>
              <h3 style={{ color: "#22d3ee" }}>{wf.name}</h3>
              {wf.description && <p className="muted">{wf.description}</p>}
              <p className="muted" style={{ fontSize: "0.75rem", marginTop: "0.5rem" }}>
                点击查看状态机
              </p>
            </div>
          ))}
        </div>
      )}

      {selectedGraph && (
        <div className="card" style={{ marginTop: "1rem" }}>
          <h3>状态机: {selectedGraph.name}</h3>
          <StateMachineGraph
            nodes={selectedGraph.data.nodes}
            edges={selectedGraph.data.edges}
          />
        </div>
      )}
    </div>
  );
}
