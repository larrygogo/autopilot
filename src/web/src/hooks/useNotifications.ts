import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./useApi";
import { useWebSocket } from "./useWebSocket";
import type { Notification, NotificationEvent } from "../lib/notification-types";

export interface UseNotificationsResult {
  items: Notification[];
  unread: number;
  loading: boolean;
  error: string | null;
  /** 还有更早的通知可加载 */
  hasMore: boolean;
  loadMore: () => Promise<void>;
  /** optimistic 标记已读 */
  markRead: (ids: number[]) => Promise<void>;
  markAllRead: () => Promise<void>;
  /** optimistic 删除（隐藏） */
  dismiss: (id: number) => Promise<void>;
  refresh: () => Promise<void>;
}

const PAGE_SIZE = 50;

/**
 * 通知流（事件型，daemon notifications 表为权威源）。
 * 首拉 list + unreadCount，订阅 notification:* 增量；read/dismiss optimistic + 失败回滚。
 */
export function useNotifications(): UseNotificationsResult {
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const { state: wsState, subscribe } = useWebSocket();
  const itemsRef = useRef<Notification[]>([]);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [page, count] = await Promise.all([
        api.listNotifications({ limit: PAGE_SIZE }),
        api.notificationUnreadCount(),
      ]);
      setItems(page.items);
      setCursor(page.next_before_id);
      setUnread(count.count);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // 首次挂载 + WS 重连时拉全量
  useEffect(() => {
    if (wsState === "connected") void refresh();
  }, [wsState, refresh]);

  // 订阅 WS 增量
  useEffect(() => {
    const unsub = subscribe("notification:*", (event: NotificationEvent) => {
      if (event.type === "notification:created") {
        const n = event.payload.notification;
        setItems([n, ...itemsRef.current.filter((x) => x.id !== n.id)]);
        setUnread((u) => u + 1);
      } else if (event.type === "notification:read") {
        const ids = new Set(event.payload.ids);
        const ts = Date.now();
        let cleared = 0;
        setItems(
          itemsRef.current.map((n) => {
            if (ids.has(n.id) && n.read_at === null) {
              cleared++;
              return { ...n, read_at: ts };
            }
            return n;
          }),
        );
        if (cleared > 0) setUnread((u) => Math.max(0, u - cleared));
      } else if (event.type === "notification:all_read") {
        const ts = Date.now();
        setItems(itemsRef.current.map((n) => (n.read_at === null ? { ...n, read_at: ts } : n)));
        setUnread(0);
      } else if (event.type === "notification:dismissed") {
        const target = itemsRef.current.find((n) => n.id === event.payload.id);
        setItems(itemsRef.current.filter((n) => n.id !== event.payload.id));
        if (target && target.read_at === null) setUnread((u) => Math.max(0, u - 1));
      }
    });
    return unsub;
  }, [subscribe]);

  const loadMore = useCallback(async () => {
    if (cursor === null) return;
    const page = await api.listNotifications({ limit: PAGE_SIZE, before_id: cursor });
    setItems([...itemsRef.current, ...page.items]);
    setCursor(page.next_before_id);
  }, [cursor]);

  const markRead = useCallback(async (ids: number[]) => {
    if (ids.length === 0) return;
    const prev = itemsRef.current;
    const idSet = new Set(ids);
    const ts = Date.now();
    const affected = prev.filter((n) => idSet.has(n.id) && n.read_at === null).length;
    setItems(prev.map((n) => (idSet.has(n.id) && n.read_at === null ? { ...n, read_at: ts } : n)));
    setUnread((u) => Math.max(0, u - affected));
    try {
      await api.markNotificationsRead(ids);
    } catch (e: unknown) {
      setItems(prev);
      setUnread((u) => u + affected);
      throw e;
    }
  }, []);

  const markAllRead = useCallback(async () => {
    const prev = itemsRef.current;
    const prevUnread = unread;
    const ts = Date.now();
    setItems(prev.map((n) => (n.read_at === null ? { ...n, read_at: ts } : n)));
    setUnread(0);
    try {
      await api.markAllNotificationsRead();
    } catch (e: unknown) {
      setItems(prev);
      setUnread(prevUnread);
      throw e;
    }
  }, [unread]);

  const dismiss = useCallback(async (id: number) => {
    const prev = itemsRef.current;
    const target = prev.find((n) => n.id === id);
    setItems(prev.filter((n) => n.id !== id));
    if (target && target.read_at === null) setUnread((u) => Math.max(0, u - 1));
    try {
      await api.dismissNotification(id);
    } catch (e: unknown) {
      setItems(prev);
      if (target && target.read_at === null) setUnread((u) => u + 1);
      throw e;
    }
  }, []);

  return {
    items,
    unread,
    loading,
    error,
    hasMore: cursor !== null,
    loadMore,
    markRead,
    markAllRead,
    dismiss,
    refresh,
  };
}
