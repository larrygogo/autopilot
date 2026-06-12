/**
 * 需求完成即清沙盒（2026-06-12）：requirement → done 时立即清理关联任务的
 * workspace（完整代码 clone，磁盘大头）。
 *
 * 此前只有被动的 retention 策略（默认 30 天 / 总量 5GB，每小时扫）——完成的
 * 需求其交付已在远程 PR 里，本地 clone 没有保留价值，攒 30 天纯占空间。
 *
 * 只清 workspace/ 目录：日志、events、agent-calls、artifacts、task 记录都保留
 * （与 retention 的清理范围一致——执行历史回看不受影响，「代码变更」diff 卡
 * 会显示已清理空态，改动本身去 PR 看）。
 *
 * cancelled 不清：取消的需求可能有未交付改动想救回，留给 retention 按期清。
 */

import { join } from "path";
import { existsSync, rmSync } from "fs";
import { onEvent, offEvent } from "../core/event-bus";
import type { AutopilotEvent } from "./protocol";
import { getRequirementById } from "../core/requirements";
import { removeTaskWorktree } from "../core/sandbox";
import { AUTOPILOT_HOME } from "../index";
import { createLogger } from "../core/logger";

const log = createLogger("done-workspace-cleanup");

/**
 * 清理某任务的 workspace 目录。返回是否真的删了东西。
 * tasksRoot 可注入（测试用 tmpdir；生产默认 AUTOPILOT_HOME/runtime/tasks）。
 */
export function cleanupTaskWorkspace(taskId: string, tasksRoot?: string): boolean {
  const root = tasksRoot ?? join(AUTOPILOT_HOME, "runtime", "tasks");
  const ws = join(root, taskId, "workspace");
  if (!existsSync(ws)) return false;
  // 旧 worktree 任务先 git worktree remove 让源仓库干净（clone 模式下 no-op）
  if (!tasksRoot) {
    try { removeTaskWorktree(taskId); } catch { /* ignore */ }
  }
  rmSync(ws, { recursive: true, force: true });
  return true;
}

let _handler: ((event: AutopilotEvent) => void) | null = null;

export function initDoneWorkspaceCleanup(): void {
  if (_handler) return;
  _handler = (event: AutopilotEvent) => {
    if (event.type !== "requirement:status-changed") return;
    const { id, to } = event.payload;
    if (to !== "done") return;
    const req = getRequirementById(id);
    if (!req?.task_id) return;
    try {
      const removed = cleanupTaskWorkspace(req.task_id);
      if (removed) {
        log.info("需求 %s 已完成，task %s 的 workspace 已清理（交付在远程 PR，本地 clone 无保留价值）", id, req.task_id);
      }
    } catch (e: unknown) {
      log.warn("需求 %s 完成后清理 task %s workspace 失败：%s", id, req.task_id, (e as Error).message);
    }
  };
  onEvent("requirement:status-changed", _handler);
  log.info("done-workspace-cleanup 已启动（需求完成即清任务 workspace）");
}

export function disposeDoneWorkspaceCleanup(): void {
  if (!_handler) return;
  offEvent("requirement:status-changed", _handler);
  _handler = null;
}
