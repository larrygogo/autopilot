import type { NotifyDriver, NotifyDriverConfig, NotifyPayload, NotifyEvent } from "./types";
import { log } from "../logger";

/**
 * Windows toast 通知 driver。
 *
 * 实现策略：
 *   1. 首选 PowerShell + BurntToast 模块（New-BurntToastNotification）
 *   2. BurntToast 缺失 → 用 msg.exe 弹一个简易消息框
 *   3. 都不行 → log.info（兜底）
 *
 * enabled() 仅在 process.platform === "win32" 返回 true。
 */
export function createWindowsToastDriver(cfg: NotifyDriverConfig): NotifyDriver {
  const allowed = new Set<NotifyEvent>(cfg.on_events ?? ["task-done", "task-failed", "phase-awaiting"]);

  return {
    name: "windows-toast",

    enabled(): boolean {
      return process.platform === "win32";
    },

    async send(payload: NotifyPayload): Promise<void> {
      if (!allowed.has(payload.event)) return;

      const title = `Autopilot · ${payload.event}`;
      const text = `[${payload.task.id}] ${payload.message}`.slice(0, 200);

      // 先试 BurntToast；powershell 单引号转义 ' → ''
      const psTitle = title.replace(/'/g, "''");
      const psText = text.replace(/'/g, "''");
      const script = `if (Get-Module -ListAvailable -Name BurntToast) { Import-Module BurntToast -ErrorAction Stop; New-BurntToastNotification -Text '${psTitle}','${psText}' } else { throw 'no-burnttoast' }`;
      const burnt = Bun.spawnSync(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
        { stdout: "pipe", stderr: "pipe" },
      );
      if (burnt.exitCode === 0) return;

      // 兜底：msg.exe（古老 NT 消息工具，几乎所有 Windows 版本都自带）
      const msg = Bun.spawnSync(["msg.exe", "*", `${title}: ${text}`], { stdout: "pipe", stderr: "pipe" });
      if (msg.exitCode === 0) return;

      log.info("[windows-toast 兜底/无 GUI] %s — %s", title, text);
    },
  };
}
