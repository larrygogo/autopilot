import { useRef, useEffect, useState, useCallback } from "react";
import { WsRpcClient, type CallOptions } from "../lib/ws-rpc-client";

export type ConnectionState = "connecting" | "connected" | "disconnected";

type EventHandler = (event: any) => void;

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const [state, setState] = useState<ConnectionState>("disconnected");
  const handlersRef = useRef(new Map<string, Set<EventHandler>>());
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef(1000);
  const shouldReconnectRef = useRef(true);

  // RPC client — 跟 ws 同生命周期；ws 断开时 reject 所有 pending
  const rpcRef = useRef<WsRpcClient | null>(null);
  if (!rpcRef.current) {
    rpcRef.current = new WsRpcClient(
      (raw) => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          throw new Error("WebSocket 未连接");
        }
        ws.send(raw);
      },
      () => wsRef.current?.readyState === WebSocket.OPEN,
    );
  }

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
        // RPC 响应：分发到 pending Promise
        if (msg.type === "res") {
          rpcRef.current?.handleResFrame(msg);
          return;
        }
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
      // pending RPC 全部 reject，避免调用方永等
      rpcRef.current?.rejectAllPending("DISCONNECTED", "WebSocket 已断开");
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

  /** 发起 RPC 请求；ws 未连接时 reject DISCONNECTED */
  const call = useCallback(
    <T = unknown>(method: string, params?: unknown, opts?: CallOptions): Promise<T> =>
      rpcRef.current!.call<T>(method, params, opts),
    [],
  );

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
      // unmount 时也清掉 pending RPC（避免后续 setState）
      rpcRef.current?.rejectAllPending("UNMOUNTED", "组件已卸载");
    };
  }, [connect]);

  return { state, subscribe, call };
}

function getTaskId(event: any): string | undefined {
  return event.payload?.taskId ?? event.payload?.task?.id;
}
