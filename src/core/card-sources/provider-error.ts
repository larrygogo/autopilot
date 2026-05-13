import type { CardSource, CardDelta } from "../now-types";
import type { AutopilotEvent } from "../../daemon/protocol";

/**
 * P0 异常：provider 凭证失效 / 模型不可用。
 *
 * **PR 1 stub**：daemon 当前没有 provider 健康检查机制（凭证由各 CLI 自己管）。
 * 此 source 占位以保持接口完整。未来引入 provider 健康检查后：
 * 1. subscribes 加 ["provider:health_changed"]（先在 protocol.ts 加事件类型）
 * 2. scan() 拉当前所有不健康 provider，每个产 P0 卡
 * 3. onEvent() 处理 healthy ↔ unhealthy 切换
 */
export function createProviderErrorSource(): CardSource {
  return {
    name: "provider-error",
    subscribes: [],

    async scan() {
      return [];
    },

    async onEvent(_event: AutopilotEvent): Promise<CardDelta[]> {
      return [];
    },
  };
}
