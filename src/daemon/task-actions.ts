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

import { existsSync, mkdirSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import { getTask, updateTask } from "../core/db";
import { transition } from "../core/state-machine";
import { executePhase } from "../core/runner";
import { getWorkflow, buildTransitions, isParallelPhase } from "../core/registry";
import { getTaskWorkspace } from "../core/workspace";
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

// ──────────────────────────────────────────────
// decideTaskAction — gate phase 的人工决断（pass / reject / cancel）
// ──────────────────────────────────────────────

export function decideTaskAction(
  taskId: string,
  decision: string,
  note: string,
  helpers: {
    /** 从 routes.ts re-export 复用，避免重复实现 */
    phaseIndex: (wf: ReturnType<typeof getWorkflow>, phase: string) => number;
    parseDecisionCounts: (raw: unknown) => Record<string, number>;
    renderDecisionMd: (d: { phase: string; decision: string; note: string; ts: string; by: string }) => string;
  },
): { from: string; to: string; decision: string; note: string } {
  if (!decision || !["pass", "reject", "cancel"].includes(decision)) {
    throw new TaskActionError("INVALID_PARAM", "decision must be one of: pass, reject, cancel");
  }
  const trimmedNote = note?.trim() ?? "";
  if (decision === "reject" && !trimmedNote) {
    throw new TaskActionError("INVALID_PARAM", "驳回必须填写理由（让 agent 知道改进方向）");
  }

  const task = getTask(taskId);
  if (!task) throw new TaskActionError("NOT_FOUND", "Task not found", 404);

  if (!task.status.startsWith("awaiting_")) {
    throw new TaskActionError("INVALID_STATE", `Task 未处于等待状态（current=${task.status}）`);
  }
  const phase = task.status.slice("awaiting_".length);

  const wf = getWorkflow(task.workflow);
  if (!wf) throw new TaskActionError("NOT_FOUND", "Workflow not found", 500);

  const transitions = buildTransitions(wf);

  let trigger: string;
  if (decision === "pass") trigger = `${phase}_pass`;
  else if (decision === "reject") trigger = `${phase}_reject_user`;
  else trigger = "cancel";

  const decisionRecord = {
    phase,
    decision,
    note: trimmedNote,
    ts: new Date().toISOString(),
    by: "user",
  };
  const extraUpdates: Record<string, unknown> = {
    last_user_decision: JSON.stringify(decisionRecord),
  };
  if (decision === "reject") {
    const counts = helpers.parseDecisionCounts(task["user_reject_counts"]);
    counts[phase] = (counts[phase] ?? 0) + 1;
    extraUpdates["user_reject_counts"] = JSON.stringify(counts);
  }

  // 写 workspace/<NN-phase>/decision.md（追加历史）
  try {
    const phaseIdx = helpers.phaseIndex(wf, phase);
    if (phaseIdx >= 0) {
      const dirName = `${String(phaseIdx).padStart(2, "0")}-${phase}`;
      const phaseDir = join(getTaskWorkspace(taskId), dirName);
      if (!existsSync(phaseDir)) mkdirSync(phaseDir, { recursive: true });
      const md = helpers.renderDecisionMd(decisionRecord);
      const dPath = join(phaseDir, "decision.md");
      if (existsSync(dPath)) {
        appendFileSync(dPath, "\n\n" + md, "utf-8");
      } else {
        writeFileSync(dPath, md, "utf-8");
      }
    }
  } catch (e: unknown) {
    // 写文件失败不阻塞决断
    log.warn("写 decision.md 失败：%s", e instanceof Error ? e.message : e);
  }

  const [from, to] = transition(taskId, trigger, {
    transitions,
    note: trimmedNote || `用户决断：${decision}`,
    extraUpdates,
  });

  if (decision !== "cancel") {
    const nextPhaseName = to.startsWith("pending_") ? to.slice("pending_".length) : null;
    if (nextPhaseName) {
      executePhase(taskId, nextPhaseName).catch(() => { /* 启动失败不影响响应 */ });
    }
  }

  return { from, to, decision, note: trimmedNote };
}
