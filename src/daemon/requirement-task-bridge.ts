/**
 * requirement-task-bridge：task 终结事件 → RunOutcome 翻译外壳（需求中心架构 v2 R1 形态）。
 *
 * 职责已收窄为「事件订阅 + 找需求 + task 状态→outcome 翻译」三件事，
 * 需求状态写入 / 终态原因 / 评审沉淀全部收进单口 `reportRunOutcome`（run-outcome.ts）。
 * R2/R3 后执行器（fix-runner 等）直接调用单口，本事件缝合外壳退役。
 *
 * 翻译表（task:transition 的 to → outcome）：
 *   - cancelled                → cancelled（note="API cancel" 是 cancelTaskAction 写死的
 *     手动取消契约，映射成 user 来源——这是 task 侧契约知识，留在翻译层）
 *   - failed_* / failed        → failed
 *   - pending_await_review     → awaiting_human（带 await_review phase 的旧 workflow）
 *   - running_fix_revision     → fixing（旧 workflow 兼容路径）
 *   - done + task.kind=fix     → fixed（fix run 修复完成回验收，v2 R3）
 *   - done                     → delivered（有无交付 PR 由 run-outcome 判定去向）
 *   - 其余                     → 忽略
 *
 * 不在此处自动恢复需求队列；scheduler 已经监听了 requirement:status-changed 事件，
 * 会在 from=running/fix_revision 的状态释放时自动 tick 启动下一个 queued 需求。
 */

import { onEvent, offEvent } from "../core/event-bus";
import type { AutopilotEvent } from "./protocol";
import { listRequirements } from "../core/requirements";
import { getTask } from "../core/db";
import { createLogger } from "../core/logger";
import { reportRunOutcome, type RunOutcome } from "./run-outcome";

const log = createLogger("requirement-task-bridge");

let _handler: ((event: AutopilotEvent) => void) | null = null;

/** task 状态 → RunOutcome 翻译表。不认识的状态返回 null（忽略）。 */
function toRunOutcome(
  taskId: string,
  taskTo: string,
  trigger: string,
  note: string | null,
): RunOutcome | null {
  if (taskTo === "cancelled" || taskTo.startsWith("failed_") || taskTo === "failed") {
    // 终态：把 task 侧的「为什么」（transition note）翻译成需求侧展示文案。
    // "API cancel" 是 cancelTaskAction 写死的手动取消契约（task-actions.ts）——根因是
    // 用户操作，映射成 user 来源，避免需求侧显示成「系统自动取消」吓到用户。
    const isManualTaskCancel = note === "API cancel";
    const reason = isManualTaskCancel ? "任务被手动取消" : note ?? `任务 ${taskId} ${taskTo}（trigger: ${trigger}）`;
    const reasonSource = isManualTaskCancel ? ("user" as const) : ("task" as const);
    return taskTo === "cancelled"
      ? { kind: "cancelled", reason, reasonSource, note: note ?? undefined }
      : { kind: "failed", reason, reasonSource, note: note ?? undefined };
  }
  if (taskTo === "pending_await_review") return { kind: "awaiting_human" };
  if (taskTo === "running_fix_revision") return { kind: "fixing" };
  if (taskTo === "done") {
    // fix run（kind=fix，v2 R3）：done = 修复已 push 回交付分支 → fixed（回验收）；
    // 普通 execution run：delivered（有无交付 PR 由 run-outcome 判定去向）。
    return getTask(taskId)?.kind === "fix" ? { kind: "fixed" } : { kind: "delivered" };
  }
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

    const req = findRequirementByTaskId(taskId);
    if (!req) return;
    const outcome = toRunOutcome(taskId, to, trigger, note);
    if (!outcome) return;
    reportRunOutcome(req.id, taskId, outcome);
  };

  onEvent("task:transition", handler);
  _handler = handler;
  log.info("requirement-task-bridge 已启动（订阅 task:transition → reportRunOutcome）");
}

export function disposeRequirementTaskBridge(): void {
  if (!_handler) return;
  offEvent("task:transition", _handler);
  _handler = null;
}
