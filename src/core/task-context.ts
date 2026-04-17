import { AsyncLocalStorage } from "node:async_hooks";

// ──────────────────────────────────────────────
// 任务执行上下文 —— 通过 AsyncLocalStorage 让深处的 Agent.run()
// 自动拿到当前 taskId / phase，无需每层手动传参。
// ──────────────────────────────────────────────

export interface TaskContext {
  taskId: string;
  phase: string;
}

const als = new AsyncLocalStorage<TaskContext>();

/** 在指定上下文中执行 callback；callback 内（包括异步调用链）可通过 getTaskContext() 读取 */
export function runWithTaskContext<T>(ctx: TaskContext, fn: () => T | Promise<T>): T | Promise<T> {
  return als.run(ctx, fn);
}

export function getTaskContext(): TaskContext | undefined {
  return als.getStore();
}
