import type { NotifyDriver, NotifyDriverConfig, NotifyPayload } from "./types";
import { log } from "../logger";

/**
 * Slack webhook driver。
 *
 * TODO（spec follow-up）：当前为 stub，仅 log。完整实现：
 *   - cfg.url 必填（Slack incoming webhook URL）
 *   - POST { text: "<title>: <body>" } 到 url
 *   - 失败 log.warn，不抛错
 */
export function createSlackWebhookDriver(cfg: NotifyDriverConfig): NotifyDriver {
  return {
    name: "slack-webhook",

    enabled(): boolean {
      // stub：未配置 url 时禁用，避免空 webhook 调用
      return typeof cfg.url === "string" && cfg.url.startsWith("https://");
    },

    async send(payload: NotifyPayload): Promise<void> {
      log.info("[slack-webhook stub url=%s] %s — %s", cfg.url ?? "<none>", payload.event, payload.message);
    },
  };
}
