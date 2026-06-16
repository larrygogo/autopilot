/**
 * submit_decision 捕获位 — agent 调 submit_decision 工具时把裁决写进这里，
 * prompt-runner 在 agent.run 返回后 takeDecision 读出来驱动状态机。
 *
 * 与 pending-questions 的异同：
 * - 同：Map<taskId> 进程内存注册表（daemon 重启即丢）。但本捕获位窗口极短——
 *   agent.run 一返回 prompt-runner 立刻 take，不像 ask_user 要跨「等人回答」长窗口。
 * - 异：ask_user 是 handler 挂 promise 等外部 resolve（框架等人）；submit_decision 是
 *   handler 写值即返回、由 prompt-runner 事后读（agent 等框架）。所以无需阻塞 promise，简单一半。
 */

export interface CapturedDecision {
  verdict: "pass" | "reject";
  reason: string;
}

const decisions = new Map<string, CapturedDecision>();

/** agent 调 submit_decision → 写捕获位（同 task 多次调用以最后一次为准）。 */
export function captureDecision(taskId: string, d: CapturedDecision): void {
  decisions.set(taskId, d);
}

/** prompt-runner 读裁决（读后删，单消费）。无则 null。 */
export function takeDecision(taskId: string): CapturedDecision | null {
  const d = decisions.get(taskId);
  decisions.delete(taskId);
  return d ?? null;
}

/** phase 起始清残留（防 retry / 上一轮 aborted run 的陈旧捕获污染）。 */
export function clearDecision(taskId: string): void {
  decisions.delete(taskId);
}
