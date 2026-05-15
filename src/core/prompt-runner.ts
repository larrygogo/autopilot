/**
 * Prompt-driven phase runner — 让用户在 yaml 里写 `prompt:` 字段即可跑一个
 * agent 调用阶段，免去写 ts 函数。
 *
 * 适用场景：纯调用 agent.run(prompt) 的阶段。不适用于需要复杂分支
 * （如 reject/解析返回结论）的阶段——那些仍然要写 ts 函数。
 *
 * 触发条件（bindPhaseFunc 中检查）：
 *   phase 有 `prompt: ...` 字段，且 workflow.ts 没导出对应 run_<name> 函数。
 *
 * 行为：
 *   1. 把 prompt 里 ${VAR} / $VAR 占位符替换成 task 上下文（title/requirement/workspace/...）
 *   2. 调用 getAgent(phase.agent || "coder", workflow.name).run(promptResolved)
 *   3. 把 result.text 写入 workspace/<NN-phase>/agent_output.md
 *
 * 没有 reject / 复杂分支；runner 会自动 complete_trigger 推进下一阶段。
 */

import { join } from "path";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { getAgent } from "../agents/registry";
import { getTask } from "./db";
import { getTaskWorkspace } from "./workspace";
import { getPhaseIndex } from "./artifacts";
import { getWorkflow, type PhaseDefinition } from "./registry";
import { createLogger } from "./logger";

const log = createLogger("prompt-runner");

/**
 * 把 prompt 里的占位符替换为 task 上下文实际值。
 *
 * 支持两种写法：
 *   - ${VAR}    （推荐，避免歧义）
 *   - $VAR      （简写）
 *
 * 内置变量：
 *   TASK_ID          任务 id
 *   TASK_TITLE       任务标题
 *   REQUIREMENT      task.requirement（用户提的需求详情）
 *   WORKSPACE        当前任务的 workspace 绝对路径
 *   PHASE            当前 phase name
 *
 * 同时支持 task 上 extras 字段（setup_func 返回的字段）：
 *   ${TASK.repo_path} 等任意嵌套字段（仅一层，避免复杂表达式）
 */
export function expandPromptTemplate(
  prompt: string,
  ctx: { taskId: string; phase: string; task: Record<string, unknown> },
): string {
  const builtins: Record<string, string> = {
    TASK_ID: ctx.taskId,
    PHASE: ctx.phase,
    TASK_TITLE: String(ctx.task["title"] ?? ""),
    REQUIREMENT: String(ctx.task["requirement"] ?? ""),
    WORKSPACE: getTaskWorkspace(ctx.taskId),
  };

  // ${VAR} 优先匹配（含 ${TASK.xxx}）
  let out = prompt.replace(/\$\{([A-Z_][A-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?)\}/g, (m, key: string) => {
    if (key.startsWith("TASK.")) {
      const field = key.slice("TASK.".length);
      const v = ctx.task[field];
      return v == null ? m : String(v);
    }
    return builtins[key] ?? m;
  });
  // $VAR 简写（不支持点号）
  out = out.replace(/\$([A-Z_][A-Z0-9_]*)\b/g, (m, key: string) => {
    return builtins[key] ?? m;
  });
  return out;
}

/**
 * 为单个 phase 生成基于 prompt 的运行函数。返回的函数签名跟 ts run_<phase> 一致，
 * 由 bindPhaseFunc 替代缺失的用户函数。
 */
export function makePromptRunner(
  phaseName: string,
  workflowName: string,
  prompt: string,
  options: {
    agent?: string;
    timeoutSec?: number;
  } = {},
): (taskId: string) => Promise<void> {
  return async (taskId: string) => {
    const task = getTask(taskId);
    if (!task) throw new Error(`任务不存在：${taskId}`);

    const resolved = expandPromptTemplate(prompt, {
      taskId,
      phase: phaseName,
      task: task as Record<string, unknown>,
    });

    const agentName = options.agent || "coder";
    const agent = getAgent(agentName, workflowName);

    log.info(
      "prompt-runner 启动 [task=%s phase=%s agent=%s prompt 长度=%d]",
      taskId, phaseName, agentName, resolved.length,
    );

    const result = await agent.run(resolved, {
      cwd: getTaskWorkspace(taskId),
      timeout: (options.timeoutSec ?? 900) * 1000,
    });

    // 输出落到 workspace/<NN-phase>/agent_output.md
    const wf = getWorkflow(workflowName);
    if (!wf) throw new Error(`工作流不存在：${workflowName}`);
    const idx = getPhaseIndex(wf, phaseName);
    const dirName = idx >= 0 ? `${String(idx).padStart(2, "0")}-${phaseName}` : phaseName;
    const dir = join(getTaskWorkspace(taskId), dirName);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const outPath = join(dir, "agent_output.md");
    const header = `<!-- generated:${new Date().toISOString()} phase:${phaseName} agent:${agentName} -->\n`;
    writeFileSync(outPath, header + result.text, "utf-8");

    log.info(
      "prompt-runner 完成 [task=%s phase=%s 输出=%s 字符]",
      taskId, phaseName, result.text.length,
    );
  };
}

/**
 * 根据 PhaseDefinition 解析 prompt + 配置，返回可绑定的运行函数。
 * 调用方应在 ts run_<name> 函数不存在时使用此函数。
 */
export function tryMakePromptRunnerForPhase(
  phase: PhaseDefinition,
  workflowName: string,
): ((taskId: string) => Promise<void>) | null {
  const prompt = (phase as Record<string, unknown>)["prompt"];
  if (typeof prompt !== "string" || prompt.trim() === "") return null;
  return makePromptRunner(phase.name, workflowName, prompt, {
    agent: phase.agent,
    timeoutSec: phase.timeout,
  });
}
