import type { CardSource, CardDelta } from "./types";
import type { NowCard } from "../now-types";
import type { AutopilotEvent } from "../events";
import { listUnhealthy, getProviderHealth } from "../provider-health";

/**
 * P0 异常：provider 凭证失效 / 模型不可用 / 连续调用失败。
 *
 * 数据来源：内存态 `provider-health`，由 `Agent.run` / `Agent.chat` 在每次调用
 * 后写入。当某 provider 连续失败 ≥ UNHEALTHY_THRESHOLD 次时 emit
 * `provider:health-changed { healthy: false }`，本 source 响应增量。
 * 任意一次成功调用立即 emit `{ healthy: true }`，本 source 移除卡片。
 *
 * 卡片 dismissable: true —— 因为是反应式诊断，可能存在误判（例如
 * prompt 本身有问题而非 provider 故障）；用户能手动隐藏。
 */

function buildCard(provider: string, reason: string, firstFailedAt?: number): NowCard {
  const preview = reason.length > 80 ? reason.slice(0, 80) + "…" : reason;
  return {
    id: `provider-error:${provider}`,
    priority: "P0",
    category: "error",
    title: `⚠ Provider ${provider} 调用连续失败`,
    subtitle: preview,
    related: { type: "provider", id: provider },
    actions: [
      { label: "去配置", kind: "primary", href: "/settings?tab=providers", intent: { kind: "configure_providers", provider } },
    ],
    dismissable: true,
    created_at: Math.floor((firstFailedAt ?? Date.now()) / 1000),
  };
}

export function createProviderErrorSource(): CardSource {
  return {
    name: "provider-error",
    subscribes: ["provider:health-changed"],

    async scan(): Promise<NowCard[]> {
      return listUnhealthy().map((s) =>
        buildCard(s.provider, s.last_reason ?? "(未知错误)", s.first_failed_at),
      );
    },

    async onEvent(event: AutopilotEvent): Promise<CardDelta[]> {
      if (event.type !== "provider:health-changed") return [];
      const { provider, healthy, reason } = event.payload;
      if (healthy) {
        return [{ op: "remove", id: `provider-error:${provider}`, reason: "resolved" }];
      }
      const state = getProviderHealth(provider);
      return [
        { op: "add", card: buildCard(provider, reason ?? "(未知错误)", state?.first_failed_at) },
      ];
    },
  };
}
