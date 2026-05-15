/**
 * Task mutation 业务函数 — 抽自 routes.ts 的 inline handler，让 HTTP routes 和
 * WS RPC（rpc-methods.ts）共用同一份业务逻辑，避免 dup。
 *
 * 错误模型：抛 TaskActionError(code, message, status?) 让 transport 层去映射
 *   - HTTP transport：error(message, status)
 *   - WS RPC：抛 RpcError(code, message)
 *
 * 副作用（emit / executePhase 等）保持跟 routes.ts inline 实现一致，
 * 不重新设计行为。
 */

import { getTask, updateTask } from "../core/db";
import { transition } from "../core/state-machine";
import { executePhase } from "../core/runner";
import { getWorkflow, buildTransitions, isParallelPhase } from "../core/registry";
import { emit } from "../core/event-bus";
import { createLogger } from "../core/logger";

const log = createLogger("task-actions");

export class TaskActionError extends Error {
  /** 给 WS RPC 用的机器枚举 code */
  code: string;
  /** 给 HTTP 用的 status code */
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = "TaskActionError";
  }
}

// ──────────────────────────────────────────────
// cancelTaskAction — 任务取消
// ──────────────────────────────────────────────

export function cancelTaskAction(taskId: string): { from: string; to: string } {
  const task = getTask(taskId);
  if (!task) throw new TaskActionError("NOT_FOUND", "Task not found", 404);

  const wf = getWorkflow(task.workflow);
  const terminalStates = new Set(["done", "cancelled"]);
  if (wf) for (const s of wf.terminal_states ?? []) terminalStates.add(s);
  if (terminalStates.has(task.status)) {
    throw new TaskActionError(
      "ALREADY_TERMINAL",
      `Task already in terminal state: ${task.status}`,
    );
  }

  const transitions = wf
    ? buildTransitions(wf)
    : { [task.status]: [["cancel", "cancelled"] as [string, string]] };

  const [from, to] = transition(taskId, "cancel", { transitions, note: "API cancel" });
  return { from, to };
}

// ──────────────────────────────────────────────
// restartTaskAction — 从当前阶段重新执行（dangling 救援）
// ──────────────────────────────────────────────

export function restartTaskAction(taskId: string): { ok: true; phase: string; from: string } {
  const task = getTask(taskId);
  if (!task) throw new TaskActionError("NOT_FOUND", "Task not found", 404);

  const wf = getWorkflow(task.workflow);
  const terminalStates = new Set(["done", "cancelled"]);
  if (wf) for (const s of wf.terminal_states ?? []) terminalStates.add(s);
  if (terminalStates.has(task.status)) {
    throw new TaskActionError(
      "ALREADY_TERMINAL",
      `Task 已是终态（${task.status}），无法重启；请新建任务`,
    );
  }

  // 从 status 提取 phase 名（running_X / pending_X / awaiting_X）
  const m = task.status.match(/^(?:running_|pending_|awaiting_)(.+)$/);
  const phase = m ? m[1] : null;
  if (!phase) {
    throw new TaskActionError(
      "INVALID_STATE",
      `无法从状态 ${task.status} 推断 phase 名，重启失败`,
    );
  }

  // 验证 phase 在 workflow 里存在
  if (wf) {
    const phaseDef = wf.phases.find((p) => {
      if (isParallelPhase(p)) return p.parallel.name === phase;
      return (p as { name: string }).name === phase;
    });
    if (!phaseDef) {
      throw new TaskActionError("PHASE_NOT_FOUND", `workflow 里没有阶段 ${phase}`);
    }
  }

  // 直接改 status + 清 dangling/pending_question；绕过状态机，因为是用户级救援
  updateTask(taskId, {
    status: `pending_${phase}`,
    dangling: false,
    pending_question: "",
  });
  log.info("任务被用户手动重启 [task=%s phase=%s 原状态=%s]", taskId, phase, task.status);
  emit({ type: "task:updated", payload: { task: getTask(taskId)!, fields: ["status"] } });

  // 异步触发执行
  executePhase(taskId, phase).catch(() => { /* 启动后异常不影响 RPC 响应 */ });

  return { ok: true, phase, from: task.status };
}

// ──────────────────────────────────────────────
// answerTaskAction — 回答 agent 的 ask_user 提问
// ──────────────────────────────────────────────

export async function answerTaskAction(taskId: string, text: string): Promise<{ ok: true }> {
  const trimmed = text.trim();
  if (!trimmed) throw new TaskActionError("INVALID_PARAM", "answer text is required");

  const { answerPending, hasPending } = await import("../agents/pending-questions");
  if (!hasPending(taskId)) {
    throw new TaskActionError("NO_PENDING", "没有待回答的问题");
  }
  const ok = answerPending(taskId, trimmed);
  if (!ok) {
    throw new TaskActionError("ALREADY_ANSWERED", "无法回答（pending 已被消费？）");
  }
  return { ok: true };
}
