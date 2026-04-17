import { useState, useEffect, useCallback } from "react";
import type { Task } from "../../core/db";
import type { AutopilotClient, AutopilotEvent } from "../../client/index";

export function useTasks(client: AutopilotClient) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const list = await client.listTasks();
      setTasks(list);
    } catch {
      // daemon 未连接时忽略
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // 通过 WebSocket 实时更新
  useEffect(() => {
    const unsub = client.subscribe("task:*", (event: AutopilotEvent) => {
      if (event.type === "task:created") {
        setTasks((prev) => [event.payload.task, ...prev]);
      } else if (event.type === "task:updated") {
        setTasks((prev) =>
          prev.map((t) => (t.id === event.payload.task.id ? event.payload.task : t))
        );
      } else if (event.type === "task:transition") {
        // 重新获取任务列表以获取最新状态
        refresh();
      }
    });

    return unsub;
  }, [client, refresh]);

  return { tasks, loading, refresh };
}
