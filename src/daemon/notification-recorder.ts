/**
 * 通知 recorder —— daemon 驻留，订阅 event-bus 把领域事件翻译成通知行。
 *
 * 设计要点：
 * - 写入收口在 core/notifications.ts（single-writer），recorder 只做事件→通知的翻译
 * - state-machine / runner / scheduler 对通知零知识；event-bus 懒激活语义天然保证
 *   「只有 daemon 在场才记通知」，而 phase 执行本身就驻留在 daemon 进程内，不漏事件
 * - 持续状态（provider 不健康 / 空状态引导）不进通知流：前者走 health banner，
 *   后者走面板空态引导 —— 通知是「刚刚发生」，不是「现在如此」
 * - 必须在 recoverDangling / scheduler 启动之前挂订阅，否则重启恢复期的 transition 漏记
 */

import { onEvent, offEvent, emit } from "../core/event-bus";
import type { AutopilotEvent } from "../core/events";
import { getTask } from "../core/db";
import { getDb } from "../core/db";
import { getRequirementById } from "../core/requirements";
import { listSubPrs } from "../core/requirements/sub-prs";
import { hasDeliveries } from "../core/requirements/deliveries";
import { createNotification, pruneNotifications } from "../core/notify/stream";
import type { CreateNotificationInput } from "../core/notify/stream";
import {
  notificationContextForRequirement,
  notificationContextForTask,
} from "../core/notify/context";
import { createLogger } from "../core/logger";
import { readSupervisorState, readCrashLoopAlertedAt, writeCrashLoopAlertedAt, isSupervisorRunning } from "./pid";

const log = createLogger("notification-recorder");

const PRUNE_INTERVAL_MS = 24 * 3600_000;

function record(input: CreateNotificationInput): void {
  try {
    const notification = createNotification(input);
    emit({ type: "notification:created", payload: { notification } });
  } catch (e: unknown) {
    // 通知失败不能影响任务执行主链路
    log.error("写通知失败 type=%s: %s", input.type, (e as Error).message);
  }
}

function preview(text: string, max = 100): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

/**
 * 启动时检查 supervisor 崩溃循环并补记通知。
 *
 * 为什么在 daemon 启动时补记、而非崩溃当下即时记：crash-loop 判定与重启由 supervisor
 * （独立父进程）做，它不接 event-bus、也不该耦合通知 DB 写入；而 daemon 每次被 respawn
 * 起来后能读到 supervisor.state。故由「活着的 daemon」代记。按 supervisor 会话 started_at
 * 去重，避免同一崩溃循环里每次 respawn 重复记。
 *
 * 局限：fatal_config（配置错误）时 supervisor 直接退出、daemon 不再被拉起，无「活着的
 * daemon」补记——那条路径仍靠 console + `daemon status`（supervisor 消失）暴露。
 */
export function checkSupervisorCrashLoop(): void {
  try {
    // supervisor 必须还活着：state 文件在 SIGKILL / 断电后残留（只有优雅退出才清），
    // 裸 `daemon run` 读到陈旧 crash_loop=true 不该记「正在崩溃循环」的假通知
    if (!isSupervisorRunning()) return;
    const st = readSupervisorState();
    if (!st || !st.crash_loop) return;
    if (readCrashLoopAlertedAt() === st.started_at) return; // 本会话已告警
    record({
      type: "supervisor_crash_loop",
      title: "runner 反复崩溃",
      body:
        `daemon 已被 supervisor 重启 ${st.restarts} 次并进入快速崩溃循环` +
        `${st.last_exit_code != null ? `（上次退出码 ${st.last_exit_code}）` : ""}。` +
        `请查 daemon 日志排因：autopilot daemon logs`,
      related: { type: "system", id: "supervisor" },
    });
    writeCrashLoopAlertedAt(st.started_at);
    log.error("supervisor 崩溃循环已记通知（restarts=%d）", st.restarts);
  } catch (e: unknown) {
    log.error("检查 supervisor 崩溃循环失败：%s", e instanceof Error ? e.message : String(e));
  }
}

// ── 事件 handlers ──────────────────────────────

function onTaskTransition(event: AutopilotEvent): void {
  if (event.type !== "task:transition") return;
  const { taskId, to } = event.payload;
  const isTerminal = to === "done" || to === "failed" || to === "cancelled";
  const isAwaitReview = to === "running_await_review";
  if (!isTerminal && !isAwaitReview) return;

  const task = getTask(taskId);
  if (!task) return;
  const context = notificationContextForTask(taskId);
  const related = { type: "task" as const, id: taskId };
  const viewTask = { intent: { kind: "view_task" as const, taskId }, kind: "primary" as const };

  if (to === "done") {
    record({ type: "task_done", title: "任务完成", body: task.title, related, context, actions: [viewTask] });
  } else if (to === "failed") {
    record({ type: "task_failed", title: "任务失败", body: task.title, related, context, actions: [viewTask] });
  } else if (to === "cancelled") {
    record({ type: "task_cancelled", title: "任务已取消", body: task.title, related, context, actions: [viewTask] });
  } else if (isAwaitReview) {
    // 每轮进入 await_review 各记一条（驳回重做多轮 = 多条，符合事件语义）
    record({
      type: "task_await_review",
      title: "方案等待评审",
      body: task.title,
      related,
      context,
      actions: [
        viewTask,
        { intent: { kind: "reject_review", taskId }, kind: "danger" },
      ],
    });
  }
}

function onReqStatusChanged(event: AutopilotEvent): void {
  if (event.type !== "requirement:status-changed") return;
  const { id, to } = event.payload;
  if (to === "awaiting_approval") {
    const req = getRequirementById(id);
    if (!req) return;
    record({
      type: "requirement_awaiting_approval",
      title: "需求等待审批",
      body: req.title,
      related: { type: "requirement", id },
      context: notificationContextForRequirement(id),
      actions: [{ intent: { kind: "view_requirement", requirementId: id }, kind: "primary" }],
    });
    return;
  }
  // artifacts 交付的验收时刻（v2 R5）：无 PR 时 awaiting_review 没有 poller 自动收口，
  // 人不来点「验收通过/驳回」流程就停摆 —— 必须通知。PR 交付不通知（merge 由 poller
  // 自动判定，验收信号在 GitHub，通知反而是噪音；PR 路径零变化）。文案不提 PR。
  if (to === "awaiting_review") {
    const req = getRequirementById(id);
    if (!req) return;
    const hasPr = (req.pr_number ?? 0) > 0 || listSubPrs(id).some((sp) => sp.pr_number > 0);
    if (hasPr || !hasDeliveries(id)) return;
    record({
      type: "requirement_awaiting_review",
      title: "交付物等待验收",
      body: req.title,
      related: { type: "requirement", id },
      context: notificationContextForRequirement(id),
      actions: [{ intent: { kind: "view_requirement", requirementId: id }, kind: "primary" }],
    });
  }
}

function onActiveQuestionChanged(event: AutopilotEvent): void {
  if (event.type !== "requirement:active-question-changed") return;
  const { id, question_id } = event.payload;
  if (question_id === null) return;
  // 读提问正文做快照预览（与旧 open-question source 同一查询路径）
  const row = getDb()
    .query<{ body: string }, [string]>(
      "SELECT body FROM requirement_comments WHERE id = ?",
    )
    .get(question_id);
  const req = getRequirementById(id);
  record({
    type: "agent_question",
    title: "AI 提了个问题",
    body: row ? preview(row.body) : (req?.title ?? id),
    related: { type: "requirement", id },
    context: notificationContextForRequirement(id),
    actions: [{ intent: { kind: "view_requirement", requirementId: id }, kind: "primary" }],
  });
}

function onClarifierError(event: AutopilotEvent): void {
  if (event.type !== "requirement:clarifier-error") return;
  const { id, reason } = event.payload;
  record({
    type: "clarifier_error",
    title: "需求澄清出错",
    body: preview(reason, 200),
    related: { type: "requirement", id },
    context: notificationContextForRequirement(id),
    actions: [
      { intent: { kind: "view_requirement", requirementId: id }, kind: "primary" },
      { intent: { kind: "retry_clarify", requirementId: id }, kind: "secondary" },
    ],
  });
}

function onScheduleError(event: AutopilotEvent): void {
  if (event.type !== "requirement:schedule-error") return;
  const { id, reason } = event.payload;
  record({
    type: "schedule_error",
    title: "起任务失败，需求已退回",
    body: preview(reason, 200),
    related: { type: "requirement", id },
    context: notificationContextForRequirement(id),
    actions: [{ intent: { kind: "view_requirement", requirementId: id }, kind: "primary" }],
  });
}

function onCiFixLimit(event: AutopilotEvent): void {
  if (event.type !== "requirement:ci-fix-limit") return;
  const { id, pr_number, reason } = event.payload;
  record({
    type: "ci_fix_limit",
    title: `PR #${pr_number} 的 CI 自动修复已达上限`,
    body: preview(reason, 200),
    related: { type: "requirement", id },
    context: notificationContextForRequirement(id),
    actions: [{ intent: { kind: "view_requirement", requirementId: id }, kind: "primary" }],
  });
}

function onWatcherRecovery(event: AutopilotEvent): void {
  if (event.type !== "watcher:recovery") return;
  const { taskId, phase, fromStatus, toStatus } = event.payload;
  record({
    type: "watcher_recovery",
    title: "任务曾卡死，已自动恢复",
    body: `${phase} 阶段：${fromStatus} → ${toStatus}（watcher 接管）`,
    related: { type: "task", id: taskId },
    context: notificationContextForTask(taskId),
    actions: [{ intent: { kind: "view_task", taskId }, kind: "primary" }],
  });
}

// ── 生命周期 ──────────────────────────────

const SUBSCRIPTIONS: Array<[string, (e: AutopilotEvent) => void]> = [
  ["task:transition", onTaskTransition],
  ["requirement:status-changed", onReqStatusChanged],
  ["requirement:active-question-changed", onActiveQuestionChanged],
  ["requirement:clarifier-error", onClarifierError],
  ["requirement:schedule-error", onScheduleError],
  ["requirement:ci-fix-limit", onCiFixLimit],
  ["watcher:recovery", onWatcherRecovery],
];

export function initNotificationRecorder(): () => void {
  try {
    pruneNotifications();
  } catch (e: unknown) {
    log.warn("启动 prune 失败：%s", (e as Error).message);
  }
  const timer = setInterval(() => {
    try {
      pruneNotifications();
    } catch (e: unknown) {
      log.warn("定期 prune 失败：%s", (e as Error).message);
    }
  }, PRUNE_INTERVAL_MS);

  for (const [type, handler] of SUBSCRIPTIONS) onEvent(type, handler);
  log.info("通知 recorder 已启动（订阅 %d 类事件）", SUBSCRIPTIONS.length);

  return () => {
    clearInterval(timer);
    for (const [type, handler] of SUBSCRIPTIONS) offEvent(type, handler);
  };
}
