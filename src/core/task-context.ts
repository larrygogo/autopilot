import { AsyncLocalStorage } from "node:async_hooks";

// ──────────────────────────────────────────────
// 任务执行上下文 —— 通过 AsyncLocalStorage 让深处的 Agent.run()
// 自动拿到当前 taskId / phase，无需每层手动传参。
// ──────────────────────────────────────────────

export interface TaskContext {
  taskId: string;
  phase: string;
  /**
   * 本次 phase 的代码 cwd —— 共用沙盒模型下是 task 启动建的那个共用 clone（runner 注入
   * getTaskSandbox(taskId)）。phase 函数 / prompt-runner 取 cwd 时用 getCurrentSandboxDir()。
   * 非 git 工作流仍注入路径（空目录），phase 不用即忽略。
   */
  sandboxDir?: string;
  /**
   * 本次 phase 的取消令牌（per-task，CONC-09）。runner 注入 registerRun 返回的 controller.signal；
   * Agent.run 兜底取它透传给 provider（provider 转 SIGTERM），phaseFn 也可经 getCurrentAbortSignal 协作检查。
   */
  signal?: AbortSignal;
}

const als = new AsyncLocalStorage<TaskContext>();

/** 在指定上下文中执行 callback；callback 内（包括异步调用链）可通过 getTaskContext() 读取 */
export function runWithTaskContext<T>(ctx: TaskContext, fn: () => T | Promise<T>): T | Promise<T> {
  return als.run(ctx, fn);
}

export function getTaskContext(): TaskContext | undefined {
  return als.getStore();
}

/** 当前 phase 的共用沙盒代码目录（无则 undefined）。 */
export function getCurrentSandboxDir(): string | undefined {
  return als.getStore()?.sandboxDir;
}

/** 当前 phase 的取消令牌（无则 undefined）。 */
export function getCurrentAbortSignal(): AbortSignal | undefined {
  return als.getStore()?.signal;
}
