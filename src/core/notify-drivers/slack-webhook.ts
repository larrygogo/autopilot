import type { NotifyDriver, NotifyDriverConfig, NotifyPayload, NotifyEvent } from "./types";
import { log } from "../logger";

/**
 * Slack webhook driver。
 *
 * 实现：POST { text: "<title>: <body>" } 到 cfg.url（Slack incoming webhook URL）。
 *
 * enabled() 要求 cfg.url 是 https URL，未配置时禁用以免空 webhook 调用。
 * 网络/响应失败仅 log.warn，不抛错（外层 notify 不阻塞）。
 */
export function createSlackWebhookDriver(cfg: NotifyDriverConfig): NotifyDriver {
  const url = typeof cfg.url === "string" ? cfg.url : "";
  const allowed = new Set<NotifyEvent>(cfg.on_events ?? ["task-done", "task-failed", "phase-awaiting"]);

  return {
    name: "slack-webhook",

    enabled(): boolean {
      return url.startsWith("https://");
    },

    async send(payload: NotifyPayload): Promise<void> {
      if (!allowed.has(payload.event)) return;

      const text = `*Autopilot · ${payload.event}*\n[${payload.task.id}] ${payload.message}`.slice(0, 2000);

      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (!resp.ok) {
          const body = await resp.text().catch(() => "");
          log.warn("slack-webhook 发送失败 [status=%d]: %s", resp.status, body.slice(0, 200));
        }
      } catch (e: unknown) {
        log.warn("slack-webhook 请求异常：%s", e instanceof Error ? e.message : String(e));
      }
    },
  };
}
