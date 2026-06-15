import type { NotifyDriver, NotifyDriverConfig, NotifyPayload, NotifyEvent } from "./types";
import { log } from "../../logger";

/**
 * Linux notify-send driver（libnotify，桌面环境内建）。
 *
 * 实现：`notify-send "<title>" "<body>"`
 *
 * enabled() 仅在 process.platform === "linux" 且 PATH 上能找到 notify-send 时返回 true，
 * 避免在没装 libnotify（或纯无头服务器）的环境上喷错。
 */
export function createLinuxNotifySendDriver(cfg: NotifyDriverConfig): NotifyDriver {
  const allowed = new Set<NotifyEvent>(cfg.on_events ?? ["task-done", "task-failed", "phase-awaiting"]);

  return {
    name: "linux-notify-send",

    enabled(): boolean {
      return process.platform === "linux" && Bun.which("notify-send") !== null;
    },

    async send(payload: NotifyPayload): Promise<void> {
      if (!allowed.has(payload.event)) return;

      const title = `Autopilot · ${payload.event}`;
      const text = `[${payload.task.id}] ${payload.message}`.slice(0, 200);

      // notify-send 以独立 argv 接收 title/body，无需 shell 转义
      const proc = Bun.spawnSync(["notify-send", title, text], { stdout: "pipe", stderr: "pipe" });
      if (proc.exitCode !== 0) {
        const stderr = proc.stderr ? new TextDecoder().decode(proc.stderr) : "";
        log.warn("linux-notify-send 发送失败 [exit=%d]: %s", proc.exitCode, stderr.slice(0, 200));
      }
    },
  };
}
