import { useEffect, useState, useCallback } from "react";
import type { CallOptions } from "../lib/ws-rpc-client";
import {
  ensureConnected,
  getConnectionState,
  addStateListener,
  subscribeChannel,
  rpcCall,
  type ConnectionState,
} from "../lib/ws-singleton";

export type { ConnectionState } from "../lib/ws-singleton";

type EventHandler = (event: any) => void;

/**
 * React hook：暴露全局唯一 WS 连接的状态 + 订阅 + RPC call。
 *
 * 内部走 ws-singleton；多个组件同时 useWebSocket 共享同一个 socket，
 * 避免之前每个 hook 实例独建连接的浪费。
 */
export function useWebSocket() {
  const [state, setState] = useState<ConnectionState>(() => getConnectionState());

  useEffect(() => {
    ensureConnected();
    return addStateListener(setState);
  }, []);

  const subscribe = useCallback((channel: string, handler: EventHandler) => {
    return subscribeChannel(channel, handler);
  }, []);

  const call = useCallback(
    <T = unknown>(method: string, params?: unknown, opts?: CallOptions): Promise<T> =>
      rpcCall<T>(method, params, opts),
    [],
  );

  return { state, subscribe, call };
}
