import React, { useEffect, useState } from "react";
import { api } from "../hooks/useApi";
import { Badge } from "../components/Badge";
import { LogTimeline } from "../components/LogTimeline";
import { StateMachineGraph } from "../components/StateMachineGraph";

interface TaskDetailProps {
  taskId: string;
  onBack: () => void;
  subscribe: (channel: string, handler: (event: any) => void) => () => void;
}

export function TaskDetail({ taskId, onBack, subscribe }: TaskDetailProps) {
  const [task, setTask] = useState<any>(null);
  const [logs, setLogs] = useState<any[]>([]);
  const [graph, setGraph] = useState<any>(null);
  const [liveLogs, setLiveLogs] = useState<string[]>([]);

  useEffect(() => {
    api.getTask(taskId).then(setTask).catch(() => {});
    api.getTaskLogs(taskId).then(setLogs).catch(() => {});
  }, [taskId]);

  useEffect(() => {
    if (!task?.workflow) return;
    api.getWorkflowGraph(task.workflow).then(setGraph).catch(() => {});
  }, [task?.workflow]);

  // 实时更新
  useEffect(() => {
    const unsub1 = subscribe(`task:${taskId}`, () => {
      api.getTask(taskId).then(setTask).catch(() => {});
      api.getTaskLogs(taskId).then(setLogs).catch(() => {});
    });
    const unsub2 = subscribe(`log:${taskId}`, (event: any) => {
      if (event.type === "log:entry") {
        setLiveLogs((prev) => [...prev.slice(-100), event.payload.message]);
      }
    });
    return () => { unsub1(); unsub2(); };
  }, [taskId, subscribe]);

  if (!task) {
    return <div className="container"><p className="muted">加载中...</p></div>;
  }

  return (
    <div className="container">
      <div className="page-hdr">
        <button className="btn-back" onClick={onBack}>← 返回</button>
        <h2>任务: {task.id}</h2>
      </div>

      <div className="card">
        <div className="task-info-grid">
          <div><span className="muted">ID：</span><span className="mono">{task.id}</span></div>
          <div><span className="muted">标题：</span>{task.title}</div>
          <div><span className="muted">工作流：</span>{task.workflow}</div>
          <div><span className="muted">状态：</span><Badge status={task.status} /></div>
          <div><span className="muted">创建时间：</span>{new Date(task.created_at).toLocaleString()}</div>
          <div><span className="muted">更新时间：</span>{new Date(task.updated_at).toLocaleString()}</div>
        </div>
      </div>

      {graph && (
        <div className="card" style={{ marginTop: "0.75rem" }}>
          <h3>状态机</h3>
          <StateMachineGraph
            nodes={graph.nodes}
            edges={graph.edges}
            currentState={task.status}
          />
        </div>
      )}

      <div className="card" style={{ marginTop: "0.75rem" }}>
        <h3>状态日志</h3>
        <LogTimeline logs={logs} />
      </div>

      {liveLogs.length > 0 && (
        <div className="card" style={{ marginTop: "0.75rem" }}>
          <h3>实时日志</h3>
          <div className="live-log">
            {liveLogs.map((line, i) => (
              <div key={i} className="log-line">{line}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
