import type { Agent } from "../../agents/agent";
import type { AgentResult, RunOptions } from "../../agents/types";
import { runWithTaskContext } from "../task/context";
import { bindTaskRunRoot } from "../sandbox";

export interface RoundAgentCtx {
  /**
   * reqgenie dev_session id —— 当合成需求 id 用（runtime/requirements/<sessionId>/...）。
   * **非真实 DB requirement 行**，仅借 runtime/requirements/<id>/ 路径约定复用 task 沙盒机制。
   */
  sessionId: string;
  phase: string;
  sandboxDir: string;
  signal?: AbortSignal;
  /** 幽灵 taskId，缺省由 sessionId 派生（同一 session 复用稳定 id，便于 agent-calls.jsonl 累积） */
  ghostTaskId?: string;
}

/** 由 sessionId 派生稳定幽灵 taskId（满足 TASK_ID_RE = [\w.\-]+）。 */
export function ghostTaskIdFor(sessionId: string): string {
  return `rs-${sessionId}`.replace(/[^\w.-]/g, "-");
}

/**
 * 在「幽灵 task」上下文里跑一轮 agent：bindTaskRunRoot 种根（无 DB 行、不调 createTask →
 * 不发 task:created），runWithTaskContext 注入 taskId/phase/sandboxDir/signal，
 * Agent.run 据此解析 agent-home + 落 agent-calls.jsonl。返回 AgentResult，不碰状态机。
 */
export async function runRoundAgent(
  ctx: RoundAgentCtx,
  agent: Agent,
  prompt: string,
  opts?: RunOptions,
): Promise<AgentResult> {
  const taskId = ctx.ghostTaskId ?? ghostTaskIdFor(ctx.sessionId);
  bindTaskRunRoot(taskId, ctx.sessionId); // 种 taskRootCache：runtime/requirements/<sessionId>/runs/<taskId>/
  // cwd 必须显式落到沙盒 clone —— Agent.run 只从 ctx 取 env/signal、不据 ctx.sandboxDir 设 cwd
  // （那是各 phaseFn 的活：phaseFn 显式传 cwd: getCurrentSandboxDir()）。A 模式无 phaseFn，rounds
  // 不另传 cwd，故在此兜底注入：否则 dev round 的 agent 子进程落在 daemon cwd、改不到交付分支工作树
  // → produceDiff/hasChanges 空 → pr 阶段开不出 PR（runner-smoke 契约冒烟当场暴露此缺口）。
  // 显式 opts.cwd 优先（调用方意图最高）。
  return await runWithTaskContext(
    { taskId, phase: ctx.phase, sandboxDir: ctx.sandboxDir, signal: ctx.signal },
    () => agent.run(prompt, { ...opts, cwd: opts?.cwd ?? ctx.sandboxDir }),
  );
}
