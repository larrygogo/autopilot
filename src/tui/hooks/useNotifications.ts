import { useState, useEffect, useCallback, useRef } from "react";
import type { AutopilotClient, AutopilotEvent } from "../../client/index";
import type { Notification } from "../../core/notify/types";

/**
 * TUI 通知流（observer-only）：只读最近通知 + 订阅增量头插。
 * 不做 markRead/dismiss —— 决策动作去 Web / CLI（观察镜像定位）。
 */
export function useNotifications(client: AutopilotClient) {
  const [items, setItems] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const itemsRef = useRef<Notification[]>([]);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const refresh = useCallback(async () => {
    try {
      const { items: fresh } = await client.listNotifications({ limit: 30 });
      setItems(fresh);
    } catch {
      // daemon 断线时忽略
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const unsub = client.subscribe("notification:*", (event: AutopilotEvent) => {
      if (event.type === "notification:created") {
        const n = event.payload.notification;
        setItems([n, ...itemsRef.current.filter((x) => x.id !== n.id)].slice(0, 30));
      } else if (event.type === "notification:read") {
        const ids = new Set(event.payload.ids);
        const ts = Date.now();
        setItems(itemsRef.current.map((n) => (ids.has(n.id) && n.read_at === null ? { ...n, read_at: ts } : n)));
      } else if (event.type === "notification:all_read") {
        const ts = Date.now();
        setItems(itemsRef.current.map((n) => (n.read_at === null ? { ...n, read_at: ts } : n)));
      } else if (event.type === "notification:dismissed") {
        setItems(itemsRef.current.filter((n) => n.id !== event.payload.id));
      }
    });
    return unsub;
  }, [client]);

  return { items, loading, refresh };
}
