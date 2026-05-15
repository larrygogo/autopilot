import { useCallback, useEffect, useState } from "react";
import { api, type TaskPhaseEvent } from "./useApi";

export interface UseTaskPhaseEventsResult {
  events: TaskPhaseEvent[];
  loading: boolean;
  refresh: () => Promise<void>;
}

/**
 * 拉取 task 的 phase 起止事件。
 * - mount 时 fetch 一次
 * - 暂不订阅 WS：phase 边界事件由调用方在 task.status 变化时 trigger refresh()
 *   组件层的"进行中 elapsed"由 setInterval 滚动，跟 events 数组无关
 */
export function useTaskPhaseEvents(taskId: string | null): UseTaskPhaseEventsResult {
  const [events, setEvents] = useState<TaskPhaseEvent[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!taskId) return;
    setLoading(true);
    try {
      const e = await api.listTaskPhaseEvents(taskId);
      setEvents(e);
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    if (!taskId) {
      setEvents([]);
      return;
    }
    refresh().catch(() => {});
  }, [taskId, refresh]);

  return { events, loading, refresh };
}
