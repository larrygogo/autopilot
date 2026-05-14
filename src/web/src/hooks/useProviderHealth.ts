import { useEffect, useRef, useState } from "react";
import { useWebSocket } from "./useWebSocket";

export interface ProviderHealthState {
  provider: string;
  healthy: boolean;
  consecutive_failures: number;
  last_reason?: string;
  first_failed_at?: number;
  last_seen_at: number;
  cli_status?: "ok" | "missing" | "unknown";
  cli_version?: string;
  cli_install_hint?: string;
  cli_checked_at?: number;
}

export interface UseProviderHealthResult {
  states: ProviderHealthState[];
  /** WS 连接状态 */
  connected: boolean;
}

/**
 * 订阅 provider 健康度（WS-only：无 HTTP fetch）。
 * - subscribe `provider:*` 频道
 * - daemon 立即推 `provider:health-snapshot`，订阅者用它初始化 state
 * - 后续 `provider:health-changed` 增量更新
 */
export function useProviderHealth(): UseProviderHealthResult {
  const [states, setStates] = useState<ProviderHealthState[]>([]);
  const { state: wsState, subscribe } = useWebSocket();
  const statesRef = useRef<ProviderHealthState[]>([]);

  useEffect(() => {
    statesRef.current = states;
  }, [states]);

  useEffect(() => {
    const unsub = subscribe("provider:*", (event: { type: string; payload: unknown }) => {
      if (event.type === "provider:health-snapshot") {
        const p = event.payload as { states: ProviderHealthState[]; ts: number };
        setStates(p.states);
      } else if (event.type === "provider:health-changed") {
        const p = event.payload as { provider: string; healthy: boolean; reason?: string; ts: number };
        const prev = statesRef.current;
        const existing = prev.find((s) => s.provider === p.provider);
        if (existing) {
          // 增量 patch：保留其他字段
          setStates(prev.map((s) =>
            s.provider === p.provider
              ? { ...s, healthy: p.healthy, last_reason: p.reason, last_seen_at: p.ts }
              : s,
          ));
        } else {
          // 还没收到 snapshot 就来 changed 时插一条最小记录
          setStates([
            ...prev,
            { provider: p.provider, healthy: p.healthy, consecutive_failures: 0, last_reason: p.reason, last_seen_at: p.ts },
          ]);
        }
      }
    });
    return unsub;
  }, [subscribe]);

  return { states, connected: wsState === "connected" };
}
