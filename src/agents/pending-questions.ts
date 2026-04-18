/**
 * 全局 pending question 注册表 — agent 调用 ask_user tool 时挂起的 promise
 * 在这里登记，UI 收到用户回答后（POST /api/tasks/:id/answer）resolve。
 *
 * 注意：状态只在 daemon 进程内存中。daemon 重启会丢失所有等待的 promise，
 * 对应 task 会卡死（agent 永远收不到 tool result）。生产场景需要 durable execution
 * （持久化协程 + SDK session resume），当前简化版只支持单进程生命周期。
 */

interface PendingEntry {
  resolve: (answer: string) => void;
  reject: (err: Error) => void;
  question: string;
  options: string[] | null;
  asked_at: string;
  phase: string;
}

const pending = new Map<string, PendingEntry>();

export function registerPending(
  taskId: string,
  entry: PendingEntry,
): void {
  // 同一 task 同时只能有一个 pending（agent 串行调用），有旧的先 reject
  const old = pending.get(taskId);
  if (old) {
    old.reject(new Error("被新的 ask_user 调用替换"));
  }
  pending.set(taskId, entry);
}

export function answerPending(taskId: string, answer: string): boolean {
  const entry = pending.get(taskId);
  if (!entry) return false;
  pending.delete(taskId);
  entry.resolve(answer);
  return true;
}

export function rejectPending(taskId: string, reason: string): boolean {
  const entry = pending.get(taskId);
  if (!entry) return false;
  pending.delete(taskId);
  entry.reject(new Error(reason));
  return true;
}

export function getPending(taskId: string): Omit<PendingEntry, "resolve" | "reject"> | null {
  const entry = pending.get(taskId);
  if (!entry) return null;
  const { resolve: _r, reject: _j, ...rest } = entry;
  return rest;
}

export function hasPending(taskId: string): boolean {
  return pending.has(taskId);
}
