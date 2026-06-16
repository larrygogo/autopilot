import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import { api } from "@/hooks/useApi";
import { useWebSocket } from "@/hooks/useWebSocket";

interface HealthState {
  provider: string;
  healthy: boolean;
  last_reason?: string;
}

/**
 * Provider 健康 banner —— 持续状态不进通知流（事件流只记「刚刚发生」），
 * 不健康时常驻面板顶部，恢复即自动消失，不可 dismiss。
 */
export function ProviderHealthBanner() {
  const [unhealthy, setUnhealthy] = useState<HealthState[]>([]);
  const { state: wsState, subscribe } = useWebSocket();

  useEffect(() => {
    if (wsState !== "connected") return;
    api.providersHealth()
      .then((list) => setUnhealthy(list.filter((s) => !s.healthy)))
      .catch(() => {});
  }, [wsState]);

  useEffect(() => {
    const unsub = subscribe("provider:*", (event: {
      type: string;
      payload: { provider?: string; healthy?: boolean; reason?: string; states?: HealthState[] };
    }) => {
      if (event.type === "provider:health-changed") {
        const { provider, healthy, reason } = event.payload;
        if (!provider) return;
        setUnhealthy((prev) => {
          const rest = prev.filter((s) => s.provider !== provider);
          return healthy ? rest : [...rest, { provider, healthy: false, last_reason: reason }];
        });
      } else if (event.type === "provider:health-snapshot" && event.payload.states) {
        setUnhealthy(event.payload.states.filter((s) => !s.healthy));
      }
    });
    return unsub;
  }, [subscribe]);

  if (unhealthy.length === 0) return null;

  return (
    <div className="mb-3 rounded-md bg-warning/8 px-3 py-2.5 text-sm">
      <div className="flex items-center gap-2 font-medium text-warning">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span>
          {unhealthy.map((s) => s.provider).join("、")} 提供商连续调用失败
        </span>
      </div>
      {unhealthy[0]?.last_reason && (
        <p className="mt-1 truncate text-xs text-muted-foreground" title={unhealthy[0].last_reason}>
          {unhealthy[0].last_reason}
        </p>
      )}
      <Link to="/settings/providers" className="mt-1 inline-block text-xs underline hover:text-foreground">
        去检查提供商配置 ▸
      </Link>
    </div>
  );
}
