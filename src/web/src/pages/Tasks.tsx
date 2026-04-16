import React, { useEffect, useState, useCallback } from "react";
import { api } from "../hooks/useApi";
import { Badge } from "../components/Badge";

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

export function Tasks({ onSelect, subscribe }: TasksProps) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    api.listTasks().then(setTasks).catch(() => {}).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    return subscribe("task:*", () => {
      refresh();
    });
  }, [subscribe, refresh]);

  if (loading) {
    return <div className="container"><p className="muted">加载中...</p></div>;
  }

  return (
    <div className="container">
      <div className="page-hdr">
        <h2>任务列表</h2>
        <span>{tasks.length} 个任务</span>
      </div>

      {tasks.length === 0 ? (
        <div className="card"><p className="muted">暂无任务</p></div>
      ) : (
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
            {tasks.map((t) => (
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
      )}
    </div>
  );
}
