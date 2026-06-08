import { AsyncLocalStorage } from "node:async_hooks";

// ──────────────────────────────────────────────
// 任务执行上下文 —— 通过 AsyncLocalStorage 让深处的 Agent.run()
// 自动拿到当前 taskId / phase，无需每层手动传参。
// ──────────────────────────────────────────────

export interface TaskContext {
  taskId: string;
  phase: string;
  /**
   * 本次 phase 的即焚 agent sandbox 临时代码目录（runner 在 acquire 后注入）。
   * phase 函数 / prompt-runner 取代码 cwd 时用 getCurrentSandboxDir()，而非常驻路径。
   * 无代码沙盒的 phase（纯文档 / 非 git 工作流）为 undefined。
   */
  sandboxDir?: string;
}

const als = new AsyncLocalStorage<TaskContext>();

/** 在指定上下文中执行 callback；callback 内（包括异步调用链）可通过 getTaskContext() 读取 */
export function runWithTaskContext<T>(ctx: TaskContext, fn: () => T | Promise<T>): T | Promise<T> {
  return als.run(ctx, fn);
}

export function getTaskContext(): TaskContext | undefined {
  return als.getStore();
}

/** 当前 phase 的即焚 sandbox 代码目录（无则 undefined）。 */
export function getCurrentSandboxDir(): string | undefined {
  return als.getStore()?.sandboxDir;
}
