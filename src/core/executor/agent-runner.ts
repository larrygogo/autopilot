import type { Agent } from "../../agents/agent";
import type { AgentResult, RunOptions } from "../../agents/types";
import { runWithTaskContext } from "../task/context";
import { bindTaskRunRoot } from "../sandbox";

export interface RoundAgentCtx {
  /** reqgenie dev_session id —— 当合成需求 id 用（runtime/requirements/<sessionId>/...） */
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
  return runWithTaskContext(
    { taskId, phase: ctx.phase, sandboxDir: ctx.sandboxDir, signal: ctx.signal },
    () => agent.run(prompt, opts),
  ) as Promise<AgentResult>;
}
