import { getDb, getTask, type Task } from "./db";
import { isLocked } from "./infra";
import { log } from "./logger";
import { runInBackground } from "./runner";
import { forceTransition } from "./state-machine";
import { getWorkflow, listWorkflows, getTerminalStates, buildTransitions } from "./registry";
import type { PhaseDefinition, ParallelDefinition } from "./registry";
import { emit } from "../daemon/event-bus";
import { applyRetentionPolicy, loadRetentionPolicy } from "./workspace";

// ──────────────────────────────────────────────
// 洪泛防护：记录每个任务上次恢复时间
// ──────────────────────────────────────────────

const lastRecoveryAttempt = new Map<string, number>();
const MIN_RECOVERY_INTERVAL_MS = 60_000; // 至少间隔 60 秒

// ──────────────────────────────────────────────
// 辅助：构建 running_state → phase_name 映射
// ──────────────────────────────────────────────

/**
 * 返回指定工作流中所有阶段的 running_state → phase_name 映射。
 * 支持普通阶段和并行子阶段。
 */
function getRunningStatePhaseMap(workflowName: string): Map<string, string> {
  const workflow = getWorkflow(workflowName);
  const map = new Map<string, string>();
  if (!workflow) return map;

  for (const phase of workflow.phases) {
    if ("parallel" in phase) {
      const par = phase.parallel as ParallelDefinition;
      for (const sub of par.phases) {
        map.set(sub.running_state, sub.name);
      }
    } else {
      const p = phase as PhaseDefinition;
      map.set(p.running_state, p.name);
    }
  }

  return map;
}

// ──────────────────────────────────────────────
// 辅助：构建 running_state → pending_state 映射
// ──────────────────────────────────────────────

function getRunningToPendingMap(workflowName: string): Map<string, string> {
  const workflow = getWorkflow(workflowName);
  const map = new Map<string, string>();
  if (!workflow) return map;

  for (const phase of workflow.phases) {
    if ("parallel" in phase) {
      const par = phase.parallel as ParallelDefinition;
      for (const sub of par.phases) {
        map.set(sub.running_state, sub.pending_state);
      }
    } else {
      const p = phase as PhaseDefinition;
      map.set(p.running_state, p.pending_state);
    }
  }

  return map;
}

// ──────────────────────────────────────────────
// 卡死任务检测
// ──────────────────────────────────────────────

/**
 * 检查并恢复卡死任务。
 *
 * 判定规则：
 * - 任务状态包含 "running_"（running 状态）
 * - 任务未持有活跃锁（进程已崩溃或退出）
 * - 任务的 updated_at 距今超过 stuckTimeoutSeconds 秒
 *
 * 恢复方式：
 * 1. 使用 forceTransition 将状态回退到 pending（保留审计日志）
 * 2. 调用 runInBackground 重新执行对应阶段
 */
export function checkStuckTasks(stuckTimeoutSeconds = 600): void {
  const db = getDb();

  // 获取所有工作流的终态集合
  const terminalStateSet = new Set<string>();
  for (const { name } of listWorkflows()) {
    for (const s of getTerminalStates(name)) {
      terminalStateSet.add(s);
    }
  }
  // 固定终态兜底
  terminalStateSet.add("done");
  terminalStateSet.add("cancelled");

  // 查询所有非终态任务（排除子任务，子任务由父任务管理）
  const rows = db
    .query<Task, []>(
      "SELECT * FROM tasks WHERE parent_task_id IS NULL"
    )
    .all();

  const nowMs = Date.now();
  const thresholdMs = stuckTimeoutSeconds * 1000;

  for (const task of rows) {
    // 跳过终态
    if (terminalStateSet.has(task.status)) continue;

    // 只处理 running 状态的任务
    if (!task.status.startsWith("running_")) continue;

    // 已持有活跃锁 → 正在执行，跳过
    if (isLocked(task.id)) continue;

    // 检查超时
    const updatedAt = new Date(task.updated_at).getTime();
    if (isNaN(updatedAt)) continue;

    const elapsedMs = nowMs - updatedAt;
    if (elapsedMs < thresholdMs) continue;

    // 洪泛防护：检查上次恢复间隔
    const lastAttempt = lastRecoveryAttempt.get(task.id) ?? 0;
    if (nowMs - lastAttempt < MIN_RECOVERY_INTERVAL_MS) {
      log.debug(
        "watcher: 跳过任务 %s 的恢复（距上次恢复不足 %ds）",
        task.id,
        MIN_RECOVERY_INTERVAL_MS / 1000
      );
      continue;
    }

    // 找到对应 phase name
    const phaseMap = getRunningStatePhaseMap(task.workflow);
    const phaseName = phaseMap.get(task.status);

    if (!phaseName) {
      log.warn(
        "watcher: 无法定位阶段 [task=%s status=%s workflow=%s]，跳过",
        task.id,
        task.status,
        task.workflow
      );
      continue;
    }

    // 找到对应 pending state，使用 forceTransition 回退并记录审计日志
    const pendingMap = getRunningToPendingMap(task.workflow);
    const pendingState = pendingMap.get(task.status);

    if (!pendingState) {
      log.warn(
        "watcher: 无法确定 pending 状态 [task=%s status=%s workflow=%s]，跳过恢复",
        task.id,
        task.status,
        task.workflow
      );
      continue;
    }

    log.warn(
      "watcher: 检测到卡死任务 [task=%s phase=%s status=%s elapsed=%ss]，尝试恢复",
      task.id,
      phaseName,
      task.status,
      Math.round(elapsedMs / 1000)
    );

    forceTransition(
      task.id,
      pendingState,
      `watcher: 检测到卡死任务，回退到 ${pendingState}（elapsed=${Math.round(elapsedMs / 1000)}s）`
    );

    emit({ type: "watcher:recovery", payload: { taskId: task.id, phase: phaseName, fromStatus: task.status, toStatus: pendingState } });
    lastRecoveryAttempt.set(task.id, nowMs);
    runInBackground(task.id, phaseName);
  }
}

/** 仅供测试：清除恢复记录 */
export function _clearRecoveryHistory(): void {
  lastRecoveryAttempt.clear();
}

/** 任务被删除时调用：移除 watcher 内存中的恢复节流记录 */
export function forgetTaskRecoveryState(taskId: string): void {
  lastRecoveryAttempt.delete(taskId);
}

// ──────────────────────────────────────────────
// Workspace 保留策略清理（由 daemon 定期触发）
// ──────────────────────────────────────────────

const terminalStateCache = new Map<string, boolean>();

function isTaskTerminal(taskId: string): boolean {
  if (terminalStateCache.has(taskId)) return terminalStateCache.get(taskId)!;
  const task = getTask(taskId);
  if (!task) return false;
  const terms = new Set<string>(["done", "cancelled", "canceled", "failed"]);
  const wf = getWorkflow(task.workflow);
  if (wf) for (const t of wf.terminal_states ?? []) terms.add(t);
  const isTerm = terms.has(task.status);
  if (isTerm) terminalStateCache.set(taskId, true);
  return isTerm;
}

/**
 * 按全局 retention 配置清理老 workspace。安全项：只清终态任务，永远不动
 * 运行中 / 待处理任务的 workspace。
 * Daemon 每隔固定周期调一次，无配置 / 空配置直接跳过。
 */
export function pruneWorkspacesByPolicy(): void {
  const policy = loadRetentionPolicy();
  if (!policy.days && !policy.max_total_mb) return;

  const result = applyRetentionPolicy(policy, {
    isTerminal: isTaskTerminal,
  });
  if (result.removed.length > 0) {
    const mb = (result.reclaimedBytes / 1024 / 1024).toFixed(1);
    log.info(
      "workspace 保留策略清理了 %d 个任务目录（回收 %s MB）",
      result.removed.length,
      mb,
    );
  }
  // 每次运行后清缓存，因为下一轮任务状态可能已变
  terminalStateCache.clear();
}
