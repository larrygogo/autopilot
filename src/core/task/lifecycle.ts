// 任务执行生命周期：per-task 取消令牌登记处（CONC-09）。
//
// 每个正在执行的 task run 一个进程内 AbortController：executePhase 入口 registerRun、
// finally unregisterRun；cancel 动作经 abortRun 触发；signal 经 task-context 注入 agent.run，
// 由 provider 转成对子进程的 SIGTERM。
//
// key = taskId：executePhase 入口 acquireLock 保证同一 task 同时只有一个 phase 在跑
//（并行块是单 executeParallelGroup 调用内的 Promise.allSettled，仍在同一把锁下），故一对一。
//
// 本模块是 src/core/ 纯机制层，零工作流知识。

const _controllers = new Map<string, AbortController>();

/** 登记一个新 run，返回其 AbortController。若已存在旧 controller（不该发生）先 abort 防泄漏。 */
export function registerRun(taskId: string): AbortController {
  const existing = _controllers.get(taskId);
  if (existing) existing.abort();
  const controller = new AbortController();
  _controllers.set(taskId, controller);
  return controller;
}

/** 注销 run（executePhase finally 调）。对未登记的 taskId 静默。 */
export function unregisterRun(taskId: string): void {
  _controllers.delete(taskId);
}

/** 触发某 task 的 in-flight 取消。返回是否真有 in-flight controller 被 abort。 */
export function abortRun(taskId: string): boolean {
  const controller = _controllers.get(taskId);
  if (!controller) return false;
  controller.abort();
  return true;
}

/** 测试用：清空所有登记。 */
export function _clearRunsForTest(): void {
  _controllers.clear();
}
