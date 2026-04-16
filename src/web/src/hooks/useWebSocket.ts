import { useRef, useEffect, useState, useCallback } from "react";

export type ConnectionState = "connecting" | "connected" | "disconnected";

type EventHandler = (event: any) => void;

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const [state, setState] = useState<ConnectionState>("disconnected");
  const handlersRef = useRef(new Map<string, Set<EventHandler>>());
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef(1000);
  const shouldReconnectRef = useRef(true);

  const getWsUrl = useCallback(() => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/ws`;
  }, []);

  const sendSubscriptions = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const channels = [...handlersRef.current.keys()];
    if (channels.length > 0) {
      ws.send(JSON.stringify({ type: "subscribe", channels }));
    }
  }, []);

  const connect = useCallback(() => {
    if (wsRef.current) return;
    setState("connecting");

    const ws = new WebSocket(getWsUrl());
    wsRef.current = ws;

    ws.onopen = () => {
      setState("connected");
      reconnectDelayRef.current = 1000;
      sendSubscriptions();
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "event") {
          const event = msg.event;
          for (const [channel, handlers] of handlersRef.current) {
            const [cat, id] = channel.split(":");
            const eventCat = event.type.split(":")[0];
            const effectiveCat = eventCat === "watcher" ? "task" : eventCat;

            if (channel === "daemon" && eventCat === "daemon") {
              handlers.forEach((h) => h(event));
            } else if (cat === effectiveCat && (id === "*" || getTaskId(event) === id)) {
              handlers.forEach((h) => h(event));
            }
          }
        }
      } catch { /* ignore */ }
    };

    ws.onclose = () => {
      wsRef.current = null;
      setState("disconnected");
      if (!shouldReconnectRef.current) return;
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        connect();
      }, reconnectDelayRef.current);
      reconnectDelayRef.current = Math.min(reconnectDelayRef.current * 2, 30000);
    };
  }, [getWsUrl, sendSubscriptions]);

  const subscribe = useCallback((channel: string, handler: EventHandler) => {
    let handlers = handlersRef.current.get(channel);
    if (!handlers) {
      handlers = new Set();
      handlersRef.current.set(channel, handlers);
      // 发送新订阅
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "subscribe", channels: [channel] }));
      }
    }
    handlers.add(handler);

    return () => {
      handlers!.delete(handler);
      if (handlers!.size === 0) {
        handlersRef.current.delete(channel);
      }
    };
  }, []);

  useEffect(() => {
    shouldReconnectRef.current = true;
    connect();
    return () => {
      shouldReconnectRef.current = false;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
    };
  }, [connect]);

  return { state, subscribe };
}

function getTaskId(event: any): string | undefined {
  return event.payload?.taskId ?? event.payload?.task?.id;
}
