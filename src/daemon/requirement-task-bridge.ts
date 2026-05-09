/**
 * requirement-task-bridge：把 task 状态变化同步到对应 requirement。
 *
 * 监听 task:transition 事件：
 *   - task → failed_*    → requirement → failed
 *   - task → cancelled   → requirement → cancelled
 *   - task → pending_await_review（submit_pr 完成）→ requirement → awaiting_review
 *   - task → running_fix_revision → requirement → fix_revision
 *   - task → done        → requirement → done（兜底，正常由 pr-poller 处理 PR merge）
 *
 * 不在此处自动恢复需求队列；scheduler 已经监听了 requirement:status-changed 事件，
 * 会在 from=running/fix_revision 的状态释放时自动 tickRepo 启动下一个 queued 需求。
 */

import { onEvent, offEvent } from "./event-bus";
import type { AutopilotEvent } from "./protocol";
import { getRequirementById, setRequirementStatus, canTransitionStatus, listRequirements } from "../core/requirements";
import { createLogger } from "../core/logger";

const log = createLogger("requirement-task-bridge");

let _handler: ((event: AutopilotEvent) => void) | null = null;

function targetReqStatus(taskTo: string): string | null {
  if (taskTo === "cancelled") return "cancelled";
  if (taskTo.startsWith("failed_") || taskTo === "failed") return "failed";
  if (taskTo === "pending_await_review") return "awaiting_review";
  if (taskTo === "running_fix_revision") return "fix_revision";
  if (taskTo === "done") return "done";
  return null;
}

function findRequirementByTaskId(taskId: string) {
  // 没有 by-task-id 索引，扫一遍（数量级不大）
  return listRequirements({}).find((r) => r.task_id === taskId) ?? null;
}

export function initRequirementTaskBridge(): void {
  if (_handler) return;

  const handler = (event: AutopilotEvent) => {
    if (event.type !== "task:transition") return;
    const { taskId, to } = event.payload;

    const reqStatus = targetReqStatus(to);
    if (!reqStatus) return;

    const req = findRequirementByTaskId(taskId);
    if (!req) return;
    if (req.status === reqStatus) return;
    if (!canTransitionStatus(req.status, reqStatus)) {
      log.warn("bridge: 跳过非法转换 req=%s %s → %s（task=%s 到 %s）",
        req.id, req.status, reqStatus, taskId, to);
      return;
    }

    try {
      setRequirementStatus(req.id, reqStatus);
      log.info("bridge: req=%s %s → %s（task=%s 到 %s）",
        req.id, req.status, reqStatus, taskId, to);
    } catch (e: unknown) {
      log.error("bridge: 同步 requirement 状态失败 req=%s: %s", req.id, (e as Error).message);
    }
  };

  onEvent("task:transition", handler);
  _handler = handler;
  log.info("requirement-task-bridge 已启动（订阅 task:transition）");
}

export function disposeRequirementTaskBridge(): void {
  if (!_handler) return;
  offEvent("task:transition", _handler);
  _handler = null;
}
