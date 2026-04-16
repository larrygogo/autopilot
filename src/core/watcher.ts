import { getDb, type Task } from "./db";
import { isLocked } from "./infra";
import { log } from "./logger";
import { runInBackground } from "./runner";
import { getWorkflow, listWorkflows, getTerminalStates } from "./registry";
import type { PhaseDefinition, ParallelDefinition } from "./registry";

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
 * 恢复方式：调用 runInBackground 重新执行对应阶段。
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

    log.warn(
      "watcher: 检测到卡死任务 [task=%s phase=%s status=%s elapsed=%ss]，尝试恢复",
      task.id,
      phaseName,
      task.status,
      Math.round(elapsedMs / 1000)
    );

    runInBackground(task.id, phaseName);
  }
}
