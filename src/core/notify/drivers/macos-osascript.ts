import type { NotifyDriver, NotifyDriverConfig, NotifyPayload, NotifyEvent } from "./types";
import { log } from "../../logger";

/**
 * macOS notify driver via osascript（macOS 内建，无外部依赖）。
 *
 * 实现：`osascript -e 'display notification "<text>" with title "<title>"'`
 *
 * enabled() 仅在 process.platform === "darwin" 返回 true。
 */
export function createMacosOsascriptDriver(cfg: NotifyDriverConfig): NotifyDriver {
  const allowed = new Set<NotifyEvent>(cfg.on_events ?? ["task-done", "task-failed", "phase-awaiting"]);

  return {
    name: "macos-osascript",

    enabled(): boolean {
      return process.platform === "darwin";
    },

    async send(payload: NotifyPayload): Promise<void> {
      if (!allowed.has(payload.event)) return;

      const title = `Autopilot · ${payload.event}`;
      const text = `[${payload.task.id}] ${payload.message}`.slice(0, 200);

      // AppleScript 字符串里 " → \"，\ → \\
      const escape = (s: string): string => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const script = `display notification "${escape(text)}" with title "${escape(title)}"`;

      const proc = Bun.spawnSync(["osascript", "-e", script], { stdout: "pipe", stderr: "pipe" });
      if (proc.exitCode !== 0) {
        const stderr = proc.stderr ? new TextDecoder().decode(proc.stderr) : "";
        log.warn("macos-osascript 发送失败 [exit=%d]: %s", proc.exitCode, stderr.slice(0, 200));
      }
    },
  };
}
