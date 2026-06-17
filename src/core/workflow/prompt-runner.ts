/**
 * Prompt-driven phase runner — 让用户在 yaml 里写 `prompt:` 字段即可跑一个
 * agent 调用阶段，免去写 ts 函数。
 *
 * 适用场景：调用 agent.run(prompt) 的阶段，含带 decision(marker/tool) 判据的
 * 评审/驳回回路（pass/reject/触顶 failed 全在框架做，零 ts）。真正机械的交付
 * （commit/push/开 PR、deliverArtifacts）仍要写 ts。
 *
 * 触发条件（bindPhaseFunc 中检查）：phase 有非空 `prompt:` 字段即用本 runner。
 *   **提示词优先（全局）**：即便同名 run_<name> ts 函数存在，也忽略它、只跑 prompt。
 *   无 prompt 字段时才回退到 ts 函数。
 *
 * 行为：
 *   1. 把 prompt 里 ${VAR} / $VAR 占位符替换成 task 上下文（title/requirement/workspace/...）
 *   2. 调用 agentForPhase(workflow.name, phase.name).run(promptResolved)
 *   3. 把 result.text 写入 workspace/<NN-phase>/agent_output.md
 *
 * 没有 reject / 复杂分支；runner 会自动 complete_trigger 推进下一阶段。
 */

import { join } from "path";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { agentForPhase, agentSupportsMcpTools } from "../../agents/registry";
import { takeDecision, clearDecision } from "../../agents/pending-decisions";
import type { InlineAgentConfig } from "../agent-defaults";
import { getTask, updateTask } from "../db";
import { getTaskSandbox, getTaskArtifactsDir } from "../sandbox";
import { getCurrentSandboxDir } from "../task/context";
import { getPhaseIndex } from "../artifacts";
import { getWorkflow, buildTransitions, type PhaseDefinition, type WorkflowDefinition } from "./registry";
import { transition, forceTransition } from "../state-machine";
import { notify } from "../notify";
import {
  planDecisionAction,
  planDecisionActionFromVerdict,
  type PhaseDecision,
  type DecisionVerdict,
} from "./phase-decision";
import { createLogger } from "../logger";
import { consumePendingPrompts } from "../task/send-prompt";
import { emit } from "../event-bus";
import { appendTaskEvent } from "../task/logs";

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

/**
 * decision mode:tool 的「自动追问」独立预算——agent 没交裁决时框架最多追问几轮。
 * 与 MAX_PROMPT_TURNS（服务用户追加 prompt）分离，避免相互耗尽（追问触顶 → ambiguous 停下报人）。
 */
const DECISION_FOLLOWUP_MAX = 2;

/** tool 模式：claude（能用 MCP 工具）的裁决指令尾段，追加到首轮 prompt。 */
const DECISION_SUFFIX_TOOL = `

## 裁决（必做）
完成上面的工作后，你必须调用 submit_decision 工具提交本阶段裁决：verdict=pass（通过、进入下一阶段）或 reject（驳回、退回重做，reason 必填，写清问题与改进方向）。不调用此工具本阶段不算完成。`;

/** tool 模式：不支持 MCP 工具的 provider 的文本契约裁决指令尾段。 */
const DECISION_SUFFIX_TEXT = `

## 裁决（必做）
完成上面的工作后，在你这次回复正文的末尾输出一个裁决 JSON 块（用 \`\`\`json 围栏包裹），格式：
\`\`\`json
{"verdict": "pass", "reason": ""}
\`\`\`
verdict 取 pass（通过）或 reject（驳回）；reject 时 reason 必填，写清问题与改进方向。不输出此块本阶段不算完成。`;

/** tool 模式追问话术（agent 没调工具时）。 */
const DECISION_NUDGE_TOOL = `你还没有调用 submit_decision 工具提交裁决。请根据上面的判据，现在就调用 submit_decision，给出 verdict（pass 或 reject），reject 时必须填 reason。`;

/** tool 模式（文本路径）追问话术（agent 没输出合规 JSON 块时）。 */
const DECISION_NUDGE_TEXT = `你还没有给出合规的裁决 JSON 块。请在回复末尾用 \`\`\`json 围栏输出 {"verdict":"pass"|"reject","reason":"..."}（reject 时 reason 必填），不要输出其他内容。`;

/**
 * tool 模式：拼追加到 prompt 末尾的尾段（纯）。= ${CRITERIA} 判据注入（把判据从
 * 「judge 私有」搬回「做裁决的 agent 可见的 prompt」）+ 按 provider 能力选裁决指令。
 */
export function buildToolDecisionSuffix(supportsTool: boolean, criteria?: string): string {
  let s = "";
  const c = criteria?.trim();
  if (c) s += `\n\n## 裁决判据\n${c}`;
  s += supportsTool ? DECISION_SUFFIX_TOOL : DECISION_SUFFIX_TEXT;
  return s;
}

/** CapturedDecision → DecisionVerdict（工具路径）。无捕获返回 null。 */
function takeDecisionVerdict(taskId: string): DecisionVerdict | null {
  const d = takeDecision(taskId);
  if (!d) return null;
  return d.verdict === "pass" ? { verdict: "pass" } : { verdict: "reject", reason: d.reason };
}

/**
 * 文本路径：从 agent 输出里解析裁决 JSON 块。容忍 ```json 围栏 / 散文包裹 /
 * 多个候选（取文本中靠后者）。reject 必须带非空 reason 才算有效候选。无有效裁决返回 null。
 */
export function parseVerdictBlock(text: string): DecisionVerdict | null {
  const cands: Array<{ s: string; at: number }> = [];
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) cands.push({ s: m[1], at: m.index ?? 0 });
  for (const m of text.matchAll(/\{[^{}]*"verdict"[^{}]*\}/g)) cands.push({ s: m[0], at: m.index ?? 0 });
  cands.sort((a, b) => b.at - a.at); // 文本中靠后的优先
  for (const c of cands) {
    let obj: unknown;
    try {
      obj = JSON.parse(c.s.trim());
    } catch {
      continue;
    }
    const v = obj as { verdict?: unknown; reason?: unknown };
    if (v?.verdict === "pass") return { verdict: "pass" };
    if (v?.verdict === "reject") {
      const reason = typeof v.reason === "string" ? v.reason.trim() : "";
      if (reason) return { verdict: "reject", reason };
    }
  }
  return null;
}

/** Phase 6: handoff 协议的 4 段标题（spec §3.10） */
const HANDOFF_SECTIONS = ["Decided", "Files", "Risks", "Remaining"] as const;
type HandoffSection = (typeof HANDOFF_SECTIONS)[number];

/** Handoff 缺段占位文案 */
const HANDOFF_MISSING_PLACEHOLDER = "无（agent 未输出）";

/** prompt 末尾追加的 handoff 指令片段（spec §3.10） */
const HANDOFF_PROMPT_SUFFIX = `

## Handoff（必填，给下一阶段读）

把以下 4 段直接写在你这次回复的正文末尾（不要写文件、不要操作任何文件），每段非空（无内容写「无」），用 markdown 二级标题分隔：
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
/** 读 task 上的 rejection_counts（在 extra JSON 里）。解析失败 → 空对象。 */
function parseRejectionCounts(task: Record<string, unknown> | null): Record<string, number> {
  if (!task) return {};
  try {
    return JSON.parse(String(task["rejection_counts"] ?? "{}")) as Record<string, number>;
  } catch {
    return {};
  }
}

/** rejection_counts（task.extra 里的 JSON 串）所有值求和 = 总驳回轮数。 */
function sumRejectionCounts(raw: unknown): number {
  try {
    const o = JSON.parse(String(raw ?? "{}")) as Record<string, number>;
    return Object.values(o).reduce((a, b) => a + (Number(b) || 0), 0);
  } catch {
    return 0;
  }
}

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
    // 沙盒交付子目录绝对路径（delivers:artifacts 时框架在 phase 跑前自动建、跑后校验非空）。
    // 给 produce 类 phase 把产物写到这——绝对路径避免 agent 幻觉出 ~/deliverables 逃逸沙盒。
    DELIVERABLES: join(codeRoot, "deliverables"),
    HANDOFF: ctx.workflow ? collectUpstreamHandoffs(ctx.taskId, ctx.workflow, ctx.phase, artifactsRoot) : "",
    REJECTION: String(ctx.task["rejection_reason"] ?? ""),
    REJECTION_COUNT: String(sumRejectionCounts(ctx.task["rejection_counts"])),
  };

  // ${HANDOFF_<phase>}：phase 名通常小写，下面通用 ${VAR} 正则只认大写 key、会整体漏掉，
  // 故单独先跑一遍。（历史 bug：${HANDOFF_design} 一直没被替换，agent 收到字面占位符 →
  // 评审拿到空内容反复驳回。dogfood req-023 暴露，2026-06-14 修。）
  let out = ctx.workflow
    ? prompt.replace(/\$\{HANDOFF_([a-zA-Z][a-zA-Z0-9_]*)\}/g, (_m, phaseName: string) =>
        readPhaseHandoff(ctx.taskId, ctx.workflow!, phaseName.toLowerCase(), artifactsRoot) ?? "")
    : prompt;

  // ${VAR} 匹配（含 ${TASK.xxx}）
  out = out.replace(/\$\{([A-Z_][A-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?)\}/g, (m, key: string) => {
    if (key.startsWith("TASK.")) {
      const field = key.slice("TASK.".length);
      const v = ctx.task[field];
      return v == null ? m : String(v);
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
    return "（上游未提供 handoff 摘要。请仅依据本提示中已给出的需求与上下文判断，不要去读取任何文件。）";
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
    /** 声明式判据 / 分支（spec 2026-06-14）。跑完 agent 后按此判 pass/reject。 */
    decision?: PhaseDecision;
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
    // phase 内联配置或默认兜底解析（不再按命名 agent 取用）
    const agent = agentForPhase(workflowName, phaseName);
    const agentName = typeof options.agent === "string" ? options.agent : agent.name;

    // tool 模式：按 provider 能力决定走工具硬契约（claude）还是文本 JSON 块降级（其余）
    const toolMode = options.decision?.mode === "tool";
    const supportsTool = toolMode && agentSupportsMcpTools(agent);
    if (toolMode) clearDecision(taskId); // 清残留（防 retry / 上一轮 aborted run 的陈旧捕获）

    // 启用 handoff 时追加 4 段输出指令；tool 模式追加判据尾段（${CRITERIA} 注入）+ 裁决指令尾段
    let promptWithHandoff = options.handoff ? resolved + HANDOFF_PROMPT_SUFFIX : resolved;
    if (toolMode) promptWithHandoff += buildToolDecisionSuffix(supportsTool, options.decision?.criteria);

    log.info(
      "prompt-runner 启动 [task=%s phase=%s agent=%s prompt 长度=%d handoff=%s decision=%s]",
      taskId, phaseName, agentName, promptWithHandoff.length, String(!!options.handoff),
      toolMode ? (supportsTool ? "tool" : "tool-text") : (options.decision?.mode ?? "none"),
    );

    // 输出目录预备
    const idx = getPhaseIndex(wf, phaseName);
    const dirName = idx >= 0 ? `${String(idx).padStart(2, "0")}-${phaseName}` : phaseName;
    const dir = join(getTaskArtifactsDir(taskId), dirName);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    // delivers:artifacts：预建沙盒 deliverables/（${DELIVERABLES} 指向它），减小 agent mkdir 出错面
    const deliverablesDir = wf.delivers === "artifacts" ? join(resolveCodeRoot(taskId), "deliverables") : null;
    if (deliverablesDir && !existsSync(deliverablesDir)) mkdirSync(deliverablesDir, { recursive: true });

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
      // tool 模式：用户追加指令可能让 agent 改主意——清掉上一轮的陈旧裁决捕获，并把裁决指令
      // 重新挂到 follow-up prompt 上，确保最终读到的裁决出自最后一轮（否则上一轮已交的裁决会
      // 赢过本轮改后的结论；文本路径读 finalText 天然免疫，工具路径靠这里对齐「最后一轮为准」）。
      if (toolMode) {
        clearDecision(taskId);
        currentPrompt += buildToolDecisionSuffix(supportsTool, options.decision?.criteria);
      }
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

    // delivers:artifacts：跑完校验 deliverables/ 非空（空 = agent 未按约定产出 → 抛错让 runner 在本
    // phase 内重做，胜过把空目录甩给下游交付器才发现）。
    if (deliverablesDir) {
      const produced = existsSync(deliverablesDir) ? readdirSync(deliverablesDir) : [];
      if (produced.length === 0) {
        throw new Error(`${phaseName} 完成但 ${deliverablesDir} 为空——agent 未把交付物写到 \${DELIVERABLES} 指向的目录`);
      }
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

    // ── 声明式判据 / 分支（spec 2026-06-14）──
    // pass：什么都不做，runner 自动 complete_trigger 推进。
    // reject：自己先 transition 走（抑制 runner 自动推进），回退重做 / 触顶 failed。
    if (options.decision) {
      const phaseDef = wf.phases.find(
        (p) => !("parallel" in p) && (p as PhaseDefinition).name === phaseName,
      ) as PhaseDefinition | undefined;
      const taskNow = getTask(taskId);
      const counts = parseRejectionCounts(taskNow as Record<string, unknown> | null);
      const meta = {
        jumpTrigger: phaseDef?.jump_trigger,
        jumpTarget: phaseDef?.jump_target,
        maxRejections: phaseDef?.max_rejections,
      };

      // marker：grep 标记同步评估；
      // tool：做 review 的 agent 自己出裁决（claude 调 submit_decision 工具 / 其余产出 JSON 块），
      //       拿不到就追问一轮（独立预算 DECISION_FOLLOWUP_MAX），触顶仍无 → ambiguous 停下报人。
      let action;
      if (options.decision.mode === "tool") {
        // 闸2 必经锁：先读本轮（agent.run 期间 submit_decision 已捕获 / finalText 含 JSON 块）
        let verdict = supportsTool ? takeDecisionVerdict(taskId) : parseVerdictBlock(finalText);
        let nudges = 0;
        while (!verdict && nudges < DECISION_FOLLOWUP_MAX) {
          nudges++;
          const r = await agent.run(supportsTool ? DECISION_NUDGE_TOOL : DECISION_NUDGE_TEXT, {
            cwd: resolveCodeRoot(taskId),
            timeout: (options.timeoutSec ?? 900) * 1000,
          });
          const nf = join(dir, `decision-nudge-${nudges}.md`);
          writeFileSync(nf, `<!-- decision-nudge:${nudges} phase:${phaseName} agent:${agentName} -->\n` + r.text, "utf-8");
          finalText = r.text;
          verdict = supportsTool ? takeDecisionVerdict(taskId) : parseVerdictBlock(finalText);
          log.info(
            "prompt-runner tool 决策追问 nudge=%d [task=%s phase=%s 拿到裁决=%s]",
            nudges, taskId, phaseName, String(!!verdict),
          );
        }
        // 决策落执行视图：把 agent 自己的裁决记进 task 事件日志（决策时刻可审计、可见）
        if (verdict && verdict.verdict !== "ambiguous") {
          try {
            appendTaskEvent(taskId, {
              type: "decision",
              phase: phaseName,
              level: "info",
              message:
                verdict.verdict === "pass"
                  ? `agent 裁决：通过（${supportsTool ? "submit_decision 工具" : "JSON 裁决块"}）`
                  : `agent 裁决：驳回 — ${verdict.reason.slice(0, 300)}`,
            });
          } catch { /* best-effort */ }
        }
        // 闸3 轨道锁：拿到 → 复用 planDecisionActionFromVerdict；触顶仍无 → ambiguous
        action = planDecisionActionFromVerdict(verdict ?? { verdict: "ambiguous" }, phaseName, meta, counts);
      } else {
        action = planDecisionAction(finalText, options.decision, phaseName, meta, counts);
      }

      if (action.kind === "ambiguous") {
        const ambiguousMsg =
          options.decision.mode === "tool"
            ? `phase「${phaseName}」追问 ${DECISION_FOLLOWUP_MAX} 轮后 agent 仍未提交合规裁决（${supportsTool ? "submit_decision 工具" : "JSON 裁决块"}），已停下报人`
              : `phase「${phaseName}」无法解析判据结论：agent 输出既未含 pass 标记「${options.decision.pass}」也未含 reject 标记「${options.decision.reject}」`;
        throw new Error(ambiguousMsg);
      }
      if (action.kind === "misconfigured") {
        throw new Error(action.reason);
      }
      if (action.kind === "fail") {
        if (taskNow) {
          try {
            await notify(
              taskNow,
              `「${phaseDef?.label ?? phaseName}」反复驳回 ${action.n} 次（≥ ${action.maxRejections}），已暂停等待人工。最近理由：${action.reason.slice(0, 200)}`,
              "task-failed",
            );
          } catch { /* notify 失败不阻塞 */ }
        }
        updateTask(taskId, {
          rejection_counts: JSON.stringify(action.counts),
          rejection_reason: action.reason,
        });
        forceTransition(taskId, "failed", `${phaseName} 判据驳回 ${action.n} 次，已暂停等待人工`);
        return;
      }
      if (action.kind === "retry") {
        const transitions = buildTransitions(wf);
        updateTask(taskId, {
          rejection_counts: JSON.stringify(action.counts),
          rejection_reason: action.reason,
        });
        transition(taskId, action.jumpTrigger, { transitions, note: `判据驳回（第${action.n}次）` });
        transition(taskId, action.retryTrigger, {
          transitions,
          note: `回退 ${action.target} 重做（第${action.n}次）`,
        });
        const { runInBackground } = await import("../runner"); // 动态 import 破循环依赖
        runInBackground(taskId, action.target);
        return;
      }
      // action.kind === "pass" → 落空，runner 自动推进
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
    decision: (phase as Record<string, unknown>)["decision"] as PhaseDecision | undefined,
  });
}
