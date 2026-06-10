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

import { onEvent, offEvent } from "../core/event-bus";
import type { AutopilotEvent } from "./protocol";
import { getRequirementById, setRequirementStatus, canTransitionStatus, listRequirements } from "../core/requirements";
import { createComment, nextCommentId } from "../core/requirement-comments";
import { getTask } from "../core/db";
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
    const { taskId, to, trigger, note } = event.payload;

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
      // 终态同步时把 task 侧的「为什么」（transition note）带给需求，让需求页直接可见。
      // "API cancel" 是 cancelTaskAction 写死的手动取消契约（task-actions.ts）——根因是
      // 用户操作，映射成 user 来源，避免需求侧显示成「系统自动取消」吓到用户。
      const isTerminal = reqStatus === "cancelled" || reqStatus === "failed";
      const isManualTaskCancel = note === "API cancel";
      setRequirementStatus(req.id, reqStatus, isTerminal ? {
        reason: isManualTaskCancel ? "任务被手动取消" : note ?? `任务 ${taskId} ${to}（trigger: ${trigger}）`,
        reason_source: isManualTaskCancel ? "user" : "task",
      } : undefined);
      log.info("bridge: req=%s %s → %s（task=%s 到 %s）",
        req.id, req.status, reqStatus, taskId, to);

      // 评审知识沉淀（防撞墙-失忆-重撞）：终态时把 task 侧最后一轮评审驳回原话写成需求
      // 评论（kind=feedback, from_role=agent），scheduler 重跑拼 requirement 文本时会带上，
      // 让新一轮 design v1 即带着上轮发现的架构约束。沉淀失败不阻塞状态同步。
      if (isTerminal) {
        try {
          const task = getTask(taskId);
          const rejection = task?.["rejection_reason"];
          if (typeof rejection === "string" && rejection.trim()) {
            createComment({
              id: nextCommentId(),
              requirement_id: req.id,
              kind: "feedback",
              from_role: "agent",
              body: `【执行评审遗留 · task ${taskId}】${note ?? to}\n\n最后一轮评审驳回理由（重跑时方案必须规避）：\n\n${rejection.slice(0, 4000)}`,
            });
            log.info("bridge: 已沉淀评审遗留为需求评论 req=%s task=%s", req.id, taskId);
          }
        } catch (e: unknown) {
          log.warn("bridge: 沉淀评审遗留失败 req=%s: %s", req.id, (e as Error).message);
        }
      }
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
