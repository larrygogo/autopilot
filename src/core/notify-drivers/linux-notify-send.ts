import type { NotifyDriver, NotifyDriverConfig, NotifyPayload } from "./types";
import { log } from "../logger";

/**
 * Linux notify-send driver。
 *
 * TODO（spec follow-up）：当前为 stub，仅 log。完整实现：
 *   - 调用 `notify-send "<title>" "<body>"`（libnotify 工具）
 *   - enabled() 检查 process.platform === "linux" + which notify-send
 *   - 处理 stderr 失败回退到 log
 */
export function createLinuxNotifySendDriver(_cfg: NotifyDriverConfig): NotifyDriver {
  return {
    name: "linux-notify-send",

    enabled(): boolean {
      // stub：默认禁用，避免在没装 libnotify 的 Linux 上喷错。
      return false;
    },

    async send(payload: NotifyPayload): Promise<void> {
      log.info("[linux-notify-send stub] %s — %s", payload.event, payload.message);
    },
  };
}
