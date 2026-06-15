/**
 * Phase 5 — 运行中 task 追加 prompt 接管入口（spec §3.8）。
 *
 * 核心问题：phase 已经把 prompt 喂给 agent.run 在跑了，怎么"追加"？
 * 选定方案：分场景三档（**不允许打断 in-flight agent.run**）。
 *
 * | 场景 | task 当前状态 | 行为                                                                   |
 * |------|--------------|------------------------------------------------------------------------|
 * | A    | running_*    | 排队进 task.extra.pending_prompts[]，当前 agent.run 完后 phase 函数消费 |
 * | B    | awaiting_*   | 若有 pending question → answerPending；否则当作 queued_prompt 排队     |
 * | C    | 终态         | 拒绝，TASK_TERMINAL 错误                                               |
 *
 * A 路径依赖：
 *   - prompt-runner.ts 跑完一轮 agent.run 后调 consumePendingPrompts() 起下一轮
 *   - ts phase 实现者主动调 consumePendingPrompts()；忘了调 runner.ts wrapper 会 warn
 */

import { getTask, appendPendingPrompt, updateTask, type PendingPromptItem } from "../db";
import { emit } from "../event-bus";
import { log } from "../logger";

export type SendPromptMode = "queued" | "answered" | "rejected";
export type SendPromptSource = "user" | "schedule" | "github";

export interface SendPromptResult {
  accepted: boolean;
  mode: SendPromptMode;
  /** 失败时填错误码（TASK_TERMINAL / NO_PROMPT_TARGET） */
  reason?: string;
}

export interface SendPromptOptions {
  source?: SendPromptSource;
}

const TERMINAL_STATES = new Set(["done", "failed", "cancelled"]);

/**
 * 主入口：发送 prompt 到 task。三档分支判定。
 *
 * 注意：本函数不打断 in-flight agent.run（spec §3.8 关键设计）。A 路径只入队不触发；
 * 消费由 prompt-runner / ts phase 函数自行调 consumePendingPrompts() 完成。
 */
export function sendPromptToTask(
  taskId: string,
  prompt: string,
  opts: SendPromptOptions = {},
): SendPromptResult {
  const task = getTask(taskId);
  if (!task) {
    return { accepted: false, mode: "rejected", reason: "NO_PROMPT_TARGET" };
  }

  const text = prompt.trim();
  if (!text) {
    return { accepted: false, mode: "rejected", reason: "EMPTY_PROMPT" };
  }

  // C 路径：终态拒绝（spec §3.8 + §5.4 TASK_TERMINAL）
  if (TERMINAL_STATES.has(task.status)) {
    return { accepted: false, mode: "rejected", reason: "TASK_TERMINAL" };
  }

  const source = opts.source ?? "user";

  // B 路径：awaiting_* + 有 pending question → answerPending
  // pending-questions 在 src/agents 下，避免 core 层依赖 agents：用动态 import 兜底
  if (task.status.startsWith("awaiting_")) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pending = require("../../agents/pending-questions") as typeof import("../../agents/pending-questions");
      if (pending.hasPending(taskId)) {
        const answered = pending.answerPending(taskId, text);
        if (answered) {
          emit({ type: "task:prompt-answered", payload: { taskId, source } });
          return { accepted: true, mode: "answered" };
        }
      }
    } catch {
      // 拿不到 pending-questions 模块（非生产环境 / 测试隔离）→ 走 A 路径排队兜底
    }
  }

  // A 路径：排队进 pending_prompts（running_* 或 awaiting_* 无 pending question）
  const item: PendingPromptItem = {
    prompt: text,
    source,
    queued_at: Date.now(),
  };
  appendPendingPrompt(taskId, item);
  emit({ type: "task:prompt-queued", payload: { taskId, source, queued_at: item.queued_at } });
  log.info("sendPromptToTask: 已排队 [task=%s source=%s status=%s]", taskId, source, task.status);
  return { accepted: true, mode: "queued" };
}

/**
 * 原子读取 + 清空 task.extra.pending_prompts，返回 prompts 数组（按 queued_at 顺序）。
 *
 * **prompt-runner 已自动调用**：纯 yaml prompt phase 跑完一轮 agent.run 后会调本函数。
 * ts phase 函数想接入需自己一行调用，否则 runner wrapper 会 emit unconsumed 警告。
 *
 * 同事务 read + clear，让两次并发消费不会重复处理同一条。
 */
export function consumePendingPrompts(taskId: string): string[] {
  const task = getTask(taskId);
  if (!task) return [];
  const extra = task as unknown as Record<string, unknown>;
  const raw = extra.pending_prompts;
  if (!Array.isArray(raw) || raw.length === 0) return [];

  const prompts = raw
    .map((entry) => (entry && typeof entry === "object" && typeof (entry as { prompt?: unknown }).prompt === "string"
      ? ((entry as { prompt: string }).prompt)
      : ""))
    .filter((s): s is string => s.length > 0);

  // 清空
  updateTask(taskId, { pending_prompts: [] });
  return prompts;
}

/**
 * 仅查询，不消费。用于 runner.ts wrapper 检查阶段函数返回后是否还有未消费的。
 */
export function peekPendingPrompts(taskId: string): string[] {
  const task = getTask(taskId);
  if (!task) return [];
  const raw = (task as unknown as Record<string, unknown>).pending_prompts;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => (entry && typeof entry === "object" && typeof (entry as { prompt?: unknown }).prompt === "string"
      ? ((entry as { prompt: string }).prompt)
      : ""))
    .filter((s): s is string => s.length > 0);
}
