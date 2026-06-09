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
 *   2. 调用 agentForPhase(workflow.name, phase.name).run(promptResolved)
 *   3. 把 result.text 写入 workspace/<NN-phase>/agent_output.md
 *
 * 没有 reject / 复杂分支；runner 会自动 complete_trigger 推进下一阶段。
 */

import { join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { agentForPhase } from "../agents/registry";
import type { InlineAgentConfig } from "./agent-defaults";
import { getTask } from "./db";
import { getTaskSandbox, getTaskArtifactsDir } from "./sandbox";
import { getCurrentSandboxDir } from "./task-context";
import { getPhaseIndex } from "./artifacts";
import { getWorkflow, type PhaseDefinition, type WorkflowDefinition } from "./registry";
import { createLogger } from "./logger";
import { consumePendingPrompts } from "./task-send-prompt";
import { emit } from "./event-bus";
import { appendTaskEvent } from "./task-logs";

const log = createLogger("prompt-runner");

/**
 * 解析 phase 的代码工作目录（agent cwd 与 ${WORKSPACE} 占位符）。
 *
 * 优先级：显式覆盖（测试夹具）> task-context 注入的共用沙盒（runner 注入 getTaskSandbox）
 * > getTaskSandbox 兜底。共用沙盒模型下 getCurrentSandboxDir() 与 getTaskSandbox 是同一个
 * 共用 clone，两者等价；保留链式取法与 dev workflow.ts 的 `getCurrentSandboxDir() ?? ...` 对齐。
 */
function resolveCodeRoot(taskId: string, override?: string): string {
  return override ?? getCurrentSandboxDir() ?? getTaskSandbox(taskId);
}

/** 同一 phase 内 pending_prompts 消费循环上限（防意外死循环 / 用户疯狂排队） */
const MAX_PROMPT_TURNS = 10;

/** Phase 6: handoff 协议的 4 段标题（spec §3.10） */
const HANDOFF_SECTIONS = ["Decided", "Files", "Risks", "Remaining"] as const;
type HandoffSection = (typeof HANDOFF_SECTIONS)[number];

/** Handoff 缺段占位文案 */
const HANDOFF_MISSING_PLACEHOLDER = "无（agent 未输出）";

/** prompt 末尾追加的 handoff 指令片段（spec §3.10） */
const HANDOFF_PROMPT_SUFFIX = `

## Handoff（必填，给下一阶段读）

在 agent_output.md 末尾输出以下 4 段，每段非空（无内容写「无」），用 markdown 二级标题分隔：
- ## Decided    做了什么决定（关键选择 + 理由）
- ## Files      关键文件路径（绝对 / 相对皆可）
- ## Risks      给下一阶段的风险与注意点
- ## Remaining  本阶段未完成 / 留给后续的事
`;

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
  ctx: {
    taskId: string;
    phase: string;
    task: Record<string, unknown>;
    workflow?: WorkflowDefinition | null;
    /** 测试用：显式 sandbox 路径，覆盖 getTaskSandbox 默认值 */
    workspaceRoot?: string;
  },
): string {
  // 代码路径（${WORKSPACE} 给 agent）与产物路径（handoff 读取）分离：产物在 artifacts/，
  // 代码在共用 clone（getCurrentSandboxDir）。测试传 ctx.workspaceRoot 时两者同源。
  const codeRoot = resolveCodeRoot(ctx.taskId, ctx.workspaceRoot);
  const artifactsRoot = ctx.workspaceRoot ?? getTaskArtifactsDir(ctx.taskId);
  const builtins: Record<string, string> = {
    TASK_ID: ctx.taskId,
    PHASE: ctx.phase,
    TASK_TITLE: String(ctx.task["title"] ?? ""),
    REQUIREMENT: String(ctx.task["requirement"] ?? ""),
    WORKSPACE: codeRoot,
    HANDOFF: ctx.workflow ? collectUpstreamHandoffs(ctx.taskId, ctx.workflow, ctx.phase, artifactsRoot) : "",
  };

  // ${VAR} 优先匹配（含 ${TASK.xxx} 和 ${HANDOFF_<NAME>}）
  let out = prompt.replace(/\$\{([A-Z_][A-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?)\}/g, (m, key: string) => {
    if (key.startsWith("TASK.")) {
      const field = key.slice("TASK.".length);
      const v = ctx.task[field];
      return v == null ? m : String(v);
    }
    if (key.startsWith("HANDOFF_") && ctx.workflow) {
      const phaseName = key.slice("HANDOFF_".length).toLowerCase();
      return readPhaseHandoff(ctx.taskId, ctx.workflow, phaseName, artifactsRoot) ?? "";
    }
    return builtins[key] ?? m;
  });
  // $VAR 简写（不支持点号 / 不支持 HANDOFF_*）
  out = out.replace(/\$([A-Z_][A-Z0-9_]*)\b/g, (m, key: string) => {
    return builtins[key] ?? m;
  });
  return out;
}

// ──────────────────────────────────────────────
// Phase 6: handoff 协议（spec §3.10）
// ──────────────────────────────────────────────

/**
 * 读取单个 phase 的 handoff.md 内容。phase 未启用 handoff 或文件不存在时返回 null。
 *
 * @param workspaceRoot 任务 workspace 根目录（默认从 getTaskSandbox(taskId) 计算；
 *   测试可显式传 tmp 路径绕过 AUTOPILOT_HOME 全局常量）
 */
export function readPhaseHandoff(
  taskId: string,
  workflow: WorkflowDefinition,
  phaseName: string,
  workspaceRoot?: string,
): string | null {
  const idx = getPhaseIndex(workflow, phaseName);
  const dirName = idx >= 0 ? `${String(idx).padStart(2, "0")}-${phaseName}` : phaseName;
  const root = workspaceRoot ?? getTaskArtifactsDir(taskId);
  const handoffPath = join(root, dirName, "handoff.md");
  if (!existsSync(handoffPath)) return null;
  try {
    return readFileSync(handoffPath, "utf-8");
  } catch { return null; }
}

/**
 * 拼接当前 phase 之前所有 phase 的 handoff.md，作为 ${HANDOFF} 占位符的值。
 * 按 phase 顺序排列；缺 handoff.md 的 phase 跳过。
 * 全部缺时返回降级提示，让下游 agent 知道要 fall back 看 agent_output.md 全文。
 */
export function collectUpstreamHandoffs(
  taskId: string,
  workflow: WorkflowDefinition,
  currentPhase: string,
  workspaceRoot?: string,
): string {
  const parts: string[] = [];
  for (const entry of workflow.phases) {
    const phaseName = "parallel" in entry ? null : entry.name;
    if (!phaseName) continue;
    if (phaseName === currentPhase) break;
    const handoff = readPhaseHandoff(taskId, workflow, phaseName, workspaceRoot);
    if (handoff) {
      const phaseDef = entry as PhaseDefinition;
      const label = phaseDef.label ?? phaseName;
      parts.push(`## ${label}\n\n${handoff}`);
    }
  }
  if (parts.length === 0) {
    return "（上游无 handoff 产物。请基于 ${REQUIREMENT} 与 agent_output.md 全文判断。）";
  }
  return parts.join("\n\n---\n\n");
}

/**
 * 从 agent_output.md 中解析 4 段（## Decided / Files / Risks / Remaining）。
 * 逐段独立解析，缺段填占位（spec §3.10 容错策略：缺一段不影响其他段）。
 *
 * 实现：扫所有 `^## <name>` 标题位置（multiline），每段内容 = 该标题下一行到
 * 下一个 `^## ` 标题之前（或文末）。
 *
 * @returns { sections, missing } — sections 是 4 段最终内容；missing 是没解析到的段名列表
 */
export function parseHandoffSections(agentOutput: string): {
  sections: Record<HandoffSection, string>;
  missing: HandoffSection[];
} {
  const sections: Record<HandoffSection, string> = {
    Decided: HANDOFF_MISSING_PLACEHOLDER,
    Files: HANDOFF_MISSING_PLACEHOLDER,
    Risks: HANDOFF_MISSING_PLACEHOLDER,
    Remaining: HANDOFF_MISSING_PLACEHOLDER,
  };
  const missing: HandoffSection[] = [];

  // 扫所有 ## XXX 标题位置（multiline）
  const headers: Array<{ name: string; start: number; lineEnd: number }> = [];
  for (const match of agentOutput.matchAll(/^##\s+(\S+)\s*$/gm)) {
    const idx = match.index ?? 0;
    headers.push({
      name: match[1],
      start: idx,
      lineEnd: idx + match[0].length,
    });
  }

  for (const name of HANDOFF_SECTIONS) {
    const headerIdx = headers.findIndex((h) => h.name === name);
    if (headerIdx === -1) {
      missing.push(name);
      continue;
    }
    const cur = headers[headerIdx];
    const next = headers[headerIdx + 1];
    const bodyStart = cur.lineEnd;
    const bodyEnd = next ? next.start : agentOutput.length;
    const body = agentOutput.slice(bodyStart, bodyEnd).trim();
    if (body) {
      sections[name] = body;
    } else {
      missing.push(name);
    }
  }

  return { sections, missing };
}

/**
 * 把解析后的 4 段 + 元信息渲染成 handoff.md 内容。
 */
function renderHandoffMd(
  sections: Record<HandoffSection, string>,
  meta: { taskId: string; phase: string; agentName: string },
): string {
  const header = `<!-- generated:${new Date().toISOString()} phase:${meta.phase} agent:${meta.agentName} task:${meta.taskId} -->\n\n`;
  const body = HANDOFF_SECTIONS
    .map((name) => `## ${name}\n\n${sections[name]}`)
    .join("\n\n");
  return header + body + "\n";
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
    agent?: string | InlineAgentConfig;
    timeoutSec?: number;
    /** Phase 6: 启用 handoff 协议（spec §3.10）。true 时 prompt 末尾追加 4 段指令，跑完解析写 handoff.md */
    handoff?: boolean;
  } = {},
): (taskId: string) => Promise<void> {
  return async (taskId: string) => {
    const task = getTask(taskId);
    if (!task) throw new Error(`任务不存在：${taskId}`);

    const wf = getWorkflow(workflowName);
    if (!wf) throw new Error(`工作流不存在：${workflowName}`);

    const resolved = expandPromptTemplate(prompt, {
      taskId,
      phase: phaseName,
      task: task as Record<string, unknown>,
      workflow: wf,
    });
    // 启用 handoff 时在 prompt 末尾追加 4 段输出指令
    const promptWithHandoff = options.handoff ? resolved + HANDOFF_PROMPT_SUFFIX : resolved;

    // phase 内联配置或默认兜底解析（不再按命名 agent 取用）
    const agent = agentForPhase(workflowName, phaseName);
    const agentName = typeof options.agent === "string" ? options.agent : agent.name;

    log.info(
      "prompt-runner 启动 [task=%s phase=%s agent=%s prompt 长度=%d handoff=%s]",
      taskId, phaseName, agentName, promptWithHandoff.length, String(!!options.handoff),
    );

    // 输出目录预备
    const idx = getPhaseIndex(wf, phaseName);
    const dirName = idx >= 0 ? `${String(idx).padStart(2, "0")}-${phaseName}` : phaseName;
    const dir = join(getTaskArtifactsDir(taskId), dirName);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    // 第一轮：用解析后的 phase prompt 跑
    let currentPrompt = promptWithHandoff;
    let turn = 0;
    let finalText = "";

    while (turn < MAX_PROMPT_TURNS) {
      turn++;
      const result = await agent.run(currentPrompt, {
        cwd: resolveCodeRoot(taskId),
        timeout: (options.timeoutSec ?? 900) * 1000,
      });

      // 每轮输出独立写文件（turn=1 落 agent_output.md，后续 follow-up-<N>.md 防覆盖）
      const fileName = turn === 1 ? "agent_output.md" : `follow-up-${turn - 1}.md`;
      const outPath = join(dir, fileName);
      const header = `<!-- generated:${new Date().toISOString()} phase:${phaseName} agent:${agentName} turn:${turn} -->\n`;
      writeFileSync(outPath, header + result.text, "utf-8");
      finalText = result.text;

      log.info(
        "prompt-runner turn=%d 完成 [task=%s phase=%s 输出=%s 字符]",
        turn, taskId, phaseName, result.text.length,
      );

      // 消费 pending_prompts（spec §3.8 A 路径自动消费）。空 → 退出循环。
      const pending = consumePendingPrompts(taskId);
      if (pending.length === 0) break;

      // 把所有 pending 拼成下一轮 prompt，附带原 prompt 上下文
      // 注意：follow-up 轮不再追加 handoff 指令；最终 handoff 解析从最后一轮 agent_output 拿
      const joined = pending.join("\n\n---\n\n");
      currentPrompt = `用户追加了以下指令，请在上一轮输出基础上继续处理：\n\n${joined}`;
      log.info(
        "prompt-runner 检测到 %d 条 pending_prompts，启动 turn=%d [task=%s phase=%s]",
        pending.length, turn + 1, taskId, phaseName,
      );
    }

    if (turn >= MAX_PROMPT_TURNS) {
      log.warn(
        "prompt-runner 达到 turn 上限 %d，丢弃剩余 pending_prompts [task=%s phase=%s]",
        MAX_PROMPT_TURNS, taskId, phaseName,
      );
    }

    // Phase 6: handoff 协议（spec §3.10）— 解析最后一轮 agent_output，抽出 4 段写 handoff.md
    if (options.handoff) {
      const { sections, missing } = parseHandoffSections(finalText);
      const handoffPath = join(dir, "handoff.md");
      const md = renderHandoffMd(sections, { taskId, phase: phaseName, agentName });
      writeFileSync(handoffPath, md, "utf-8");

      if (missing.length > 0) {
        log.warn(
          "prompt-runner handoff 不完整 [task=%s phase=%s missing=%s]",
          taskId, phaseName, missing.join(","),
        );
        emit({
          type: "phase:handoff-incomplete",
          payload: { taskId, phase: phaseName, missing: missing.map(String) },
        });
        try {
          appendTaskEvent(taskId, {
            type: "handoff-incomplete",
            phase: phaseName,
            level: "warn",
            message: `handoff 缺 ${missing.length} 段：${missing.join(",")}（占位 "${HANDOFF_MISSING_PLACEHOLDER}"）`,
          });
        } catch { /* best-effort */ }
      } else {
        log.info("prompt-runner handoff 写入完成 [task=%s phase=%s]", taskId, phaseName);
      }
    }
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
    handoff: phase.handoff === true,
  });
}
