import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { onEvent, offEvent, emit } from "../core/event-bus";
import type { AutopilotEvent } from "./protocol";
import { getRequirementById, updateRequirement, setActiveQuestionId, setRequirementStatus } from "../core/requirements";
import { getProjectById } from "../core/projects";
import { getWorkspaceById } from "../core/workspaces";
import {
  createComment,
  nextCommentId,
  listComments,
} from "../core/requirement-comments";
import { createSpecRevision } from "../core/spec-revisions";
import { createLogger } from "../core/logger";
import {
  startRound,
  setPhase,
  endRound,
} from "./clarifier-progress";
import { buildClarifierAgent } from "./clarifier-agent";
import { parseLlmYamlWrapper } from "../core/llm-yaml";
import { listAttachments, buildAttachmentContext } from "../core/requirement-attachments";

const log = createLogger("requirement-clarifier");

// 默认 agent name: "clarifier"
// 用户配置示例（写在 ~/.autopilot/config.yaml）：
//   agents:
//     clarifier:
//       provider: anthropic
//       model: claude-sonnet-4-6
//       system_prompt: |
//         （可选）覆盖默认的"需求分析师"system prompt
// 没配 clarifier 也能跑：registry 会用全局默认 provider/model。

// ──────────────────────────────────────────────
// AI 调用层（可测试注入）
// ──────────────────────────────────────────────

type ClarifyFn = (prompt: string, reqId: string) => Promise<string>;

let _clarifyFn: ClarifyFn = callClaude;

export function _setClarifyFnForTest(fn: ClarifyFn | null): void {
  _clarifyFn = fn ?? callClaude;
}

async function callClaude(prompt: string, reqId: string): Promise<string> {
  // 通过 agent 系统调用。merge 顺序：req-level override > 全局 agents.clarifier > 默认 (anthropic + provider 默认 model)
  let agent;
  try {
    const req = getRequirementById(reqId);
    const override: { provider?: "anthropic" | "openai" | "google"; model?: string } = {};
    if (req?.clarifier_provider) override.provider = req.clarifier_provider as "anthropic" | "openai" | "google";
    if (req?.clarifier_model) override.model = req.clarifier_model;
    agent = buildClarifierAgent(override);
  } catch (e: unknown) {
    throw new Error(`无法初始化 clarifier agent：${e instanceof Error ? e.message : String(e)}`);
  }

  const result = await agent.run(prompt);
  const text = result.text.trim();
  if (!text) {
    throw new Error("clarifier agent 返回空");
  }
  return text;
}

// ──────────────────────────────────────────────
// Prompt 构造
// ──────────────────────────────────────────────

function readWorkspaceContext(workspacePath: string): string {
  const candidates = ["CLAUDE.md", "README.md", "README"];
  const snippets: string[] = [];
  for (const name of candidates) {
    const file = join(workspacePath, name);
    if (existsSync(file)) {
      const content = readFileSync(file, "utf-8").slice(0, 4000);
      snippets.push(`### ${name}\n${content}`);
    }
  }
  return snippets.join("\n\n");
}

function buildPrompt(opts: {
  projectName: string;
  projectDescription: string | null;
  workspaceAlias: string | null;
  workspaceContext: string | null;
  title: string;
  specMd: string;
  qaHistory: string;
  attachmentContext: string;
}): string {
  const ctxLines: string[] = [];
  ctxLines.push(`项目名称：${opts.projectName}`);
  if (opts.projectDescription) ctxLines.push(`项目描述：${opts.projectDescription}`);
  if (opts.workspaceAlias) ctxLines.push(`关联工作区：${opts.workspaceAlias}`);
  if (opts.workspaceContext) {
    ctxLines.push("");
    ctxLines.push("## 工作区文档");
    ctxLines.push(opts.workspaceContext);
  }

  // 附件上下文段落（图片注入路径，文档内联文本）
  const attachmentSection = opts.attachmentContext
    ? ["# 附件", "", opts.attachmentContext, ""]
    : [];

  return [
    "你是一位软件需求分析师，正在持续优化一份需求规约（spec_md）并一问一答地澄清需求。",
    "",
    "# 任务",
    "1. 根据当前 spec_md 和已有 Q&A 历史，**精确修订** spec_md：",
    "   - 保留原文中正确的内容（不要重写整篇）",
    "   - 只改不对的、只加缺失的、只删冗余的",
    "   - 不要在 new_spec_md 字段值里再包 ``` 代码块",
    "2. 决定下一个最该问的问题，或宣告澄清完成。",
    "",
    "# 输出格式（严格 YAML，顶层对象）",
    "用 YAML 而不是 JSON 的理由：new_spec_md / next_question.agent_text 等字段经常含",
    "**任意引号 / 中文 / 多行 / 反斜杠**，YAML 的 `|` 多行块完全不需要转义，从根上",
    "绕开 JSON 字符串转义地狱。模板：",
    "",
    "```yaml",
    "new_spec_md: |",
    "  # 修订后的完整 spec_md，多行任意内容，不需要转义",
    "  ## 背景",
    "  ...",
    "summary: 本轮改了什么（短，1-2 句）；无变化时填 null",
    "next_question:",
    "  agent_text: |",
    "    下一个问题（可多行，含任意引号 / 中文 / 反斜杠都行）",
    "  suggestions:",
    "    - 短选项 A",
    "    - 短选项 B",
    "done: false",
    "new_title: 改进后的需求标题（10-20 字）",
    "```",
    "",
    "字段说明：",
    "- `next_question`: 不再追问时整字段设为 `null`（含 agent_text 整体）",
    "- `done`: true 时 `next_question` 必须为 null",
    "- `new_title`: 当前 title 已足够好时设为 `null`",
    "- `summary`: spec_md 无变化时设为 `null`",
    "",
    "# 关键规则",
    "- 如果 spec_md 没变化，new_spec_md 仍要原样输出，但 summary 可为 null。",
    "- 下一个问题必须**基于最新 spec_md 和已有 Q&A**，不要重复问已澄清的事。",
    "- 如果信息已足够实现需求，输出 done=true 且 next_question=null。",
    "- 标题（title）应该一句话概括需求；如果当前 title 看起来是用户直接从描述粗截的（如带省略号、半句话、过长），用 new_title 给出更好的版本。如果当前 title 已经准确，new_title 为 null。",
    "- 输出**只有 YAML**，前后没有任何额外解释 / markdown 文本。围栏可有可无（解析时会自动剥）。",
    "",
    "# 上下文",
    ctxLines.join("\n"),
    "",
    ...attachmentSection,
    "# 需求标题",
    opts.title,
    "",
    "# 当前 spec_md",
    opts.specMd || "(空)",
    "",
    opts.qaHistory ? "# 已完成的 Q&A 历史\n\n" + opts.qaHistory : "# 已完成的 Q&A 历史\n\n(暂无)",
    "",
    "请直接输出 YAML：",
  ].join("\n");
}

// ──────────────────────────────────────────────
// 核心：单轮 clarifier
// ──────────────────────────────────────────────

interface ClarifyResult {
  new_spec_md: string;
  summary: string | null;
  next_question: { agent_text: string; suggestions: string[] } | null;
  done: boolean;
  new_title: string | null;
}

function parseClarifyResult(raw: string): ClarifyResult {
  // 走 llm-yaml 顶层 wrapper：剥围栏 + YAML 解析。YAML 解析对 LLM 输出格式
  // 更宽容（兼容 JSON、容忍轻微缩进偏移、支持 | 多行块零转义）。
  const parsed = parseLlmYamlWrapper(raw);
  if (typeof parsed.new_spec_md !== "string") throw new Error("missing/invalid new_spec_md");
  if (typeof parsed.done !== "boolean") throw new Error("missing/invalid done");
  const summary = parsed.summary === null || typeof parsed.summary === "string" ? parsed.summary : null;
  // new_title 是 PR-A 之后的扩展，可选字段；不存在或非字符串都视为 null
  const new_title = typeof parsed.new_title === "string" && parsed.new_title.trim() !== ""
    ? parsed.new_title.trim()
    : null;
  const next_question = parsed.next_question === null ? null
    : (parsed.next_question && typeof parsed.next_question === "object"
        ? {
            agent_text: String((parsed.next_question as Record<string, unknown>).agent_text ?? ""),
            suggestions: Array.isArray((parsed.next_question as Record<string, unknown>).suggestions)
              ? (parsed.next_question as Record<string, unknown[]>).suggestions.map(String)
              : [],
          }
        : null);
  if (!parsed.done && (!next_question || !next_question.agent_text)) {
    throw new Error("done=false but next_question is empty");
  }
  return {
    new_spec_md: parsed.new_spec_md as string,
    summary,
    next_question,
    done: parsed.done,
    new_title,
  };
}

/**
 * 同一 requirement 同时只跑一个 clarifier round。
 * 必要：question-resolved handler、retry-clarify API、watchdog 三处都可能并发触发；
 * 不加锁会导致重复 createQuestion + setActiveQuestionId 留下多个 open question / 覆盖。
 */
const _inflightRounds = new Set<string>();

/** 测试用：清空进程内锁状态。 */
export function _resetInflightForTest(): void {
  _inflightRounds.clear();
}

export async function runClarifierRound(reqId: string): Promise<void> {
  // 进入时 trace 锁集合状态，便于复现 race 时定位（dogfood 抓到一次 watchdog
  // 触发后 active_question_id 被并发写，疑似锁失效，根因待复现）。
  log.info(
    "clarifier: req=%s 进入 runClarifierRound, inflight=[%s]",
    reqId,
    [..._inflightRounds].join(","),
  );
  if (_inflightRounds.has(reqId)) {
    log.info("clarifier: req=%s 已在跑，跳过重复 trigger", reqId);
    return;
  }
  _inflightRounds.add(reqId);
  try {
    await _runClarifierRoundInner(reqId);
  } finally {
    _inflightRounds.delete(reqId);
    // 兜底：inner 抛错跳过 endRound 时清理。Map 里没 entry 时是 no-op。
    endRound(reqId, "errored");
    log.info("clarifier: req=%s 释放锁，inflight=[%s]", reqId, [..._inflightRounds].join(","));
  }
}

async function _runClarifierRoundInner(reqId: string): Promise<void> {
  const req = getRequirementById(reqId);
  if (!req || req.status !== "clarifying") return;

  startRound(reqId, "");

  // ── DB 层乐观锁基线 ────────────────────────────────────────
  // 记录本轮开始时的 active_question_id。LLM 调用结束、要写入新 question 时
  // 再 re-fetch 验证；若已被并发 round 改动（如 watchdog + question-resolved
  // handler 同时触发，进程内锁未拦下），放弃本轮结果，避免出现多个 active
  // question 或把开放问题误覆盖。
  const initialActiveQid = req.active_question_id;

  const project = req.project_id ? getProjectById(req.project_id) : null;
  if (!project) {
    log.warn("clarifier: req=%s 找不到项目，跳过", reqId);
    endRound(reqId, "aborted");
    return;
  }
  const workspace = req.workspace_id ? getWorkspaceById(req.workspace_id) : null;

  // 开始新一轮：清除上次的错误（如果有）
  if (req.clarifier_error) {
    updateRequirement(reqId, { clarifier_error: null });
  }

  // 历史 Q&A 重建：从 requirement_comments 拿 question 顶层 + parent_id 关联的 user reply
  const allQuestionsResolved = listComments(reqId, { kind: "question", status: "resolved", parent_id: null });
  const qaHistory = allQuestionsResolved
    .map((q, i) => {
      const userReply = listComments(reqId, { kind: "question", parent_id: q.id })
        .find(r => r.from_role === "user")?.body ?? "(未回复)";
      return `Q${i + 1}：${q.body}\nA${i + 1}：${userReply}`;
    }).join("\n\n");

  // 读取需求的所有附件，构建 prompt 段落
  const attachments = listAttachments(reqId);
  const attachmentContext = buildAttachmentContext(attachments);

  const prompt = buildPrompt({
    projectName: project.name,
    projectDescription: project.description,
    workspaceAlias: workspace?.alias ?? null,
    workspaceContext: workspace?.path ? readWorkspaceContext(workspace.path) : null,
    title: req.title,
    specMd: req.spec_md ?? "",
    qaHistory,
    attachmentContext,
  });

  setPhase(reqId, "calling-llm", { attempt: 0, prompt });

  let result: ClarifyResult | null = null;
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw = "";
    try {
      if (attempt > 0) {
        setPhase(reqId, "calling-llm", { attempt: 1 });
      }
      raw = await _clarifyFn(prompt, reqId);
      result = parseClarifyResult(raw);
      break;
    } catch (e: unknown) {
      lastError = e instanceof Error ? e : new Error(String(e));
      log.warn(
        "clarifier: req=%s 第 %d 次解析失败: %s%s",
        reqId,
        attempt + 1,
        lastError.message,
        raw ? `；原始输出（前 500 字）: ${raw.slice(0, 500)}` : "",
      );
      if (attempt === 0) {
        setPhase(reqId, "parsing", { attempt: 1, last_parse_error: lastError.message });
      }
    }
  }

  if (!result) {
    const reason = lastError?.message ?? "unknown error";
    updateRequirement(reqId, { clarifier_error: reason });
    emit({
      type: "requirement:clarifier-error",
      payload: { id: reqId, reason },
    });
    endRound(reqId, "errored");
    return;
  }

  // Race protection: status may have changed (e.g. user called finish-clarification)
  // between the initial check and the AI response. Re-fetch and abort if no longer clarifying.
  const reqAfter = getRequirementById(reqId);
  if (!reqAfter || reqAfter.status !== "clarifying") {
    log.info("clarifier: req=%s 状态已变（%s），AI 结果丢弃", reqId, reqAfter?.status ?? "deleted");
    endRound(reqId, "aborted");
    return;
  }
  // Race protection: 另一并发 round 已经写过新 question / 关闭澄清，本轮放弃。
  if (reqAfter.active_question_id !== initialActiveQid) {
    log.info(
      "clarifier: req=%s active_question_id 已被并发 round 改动（%s → %s），放弃本轮结果",
      reqId,
      initialActiveQid ?? "null",
      reqAfter.active_question_id ?? "null",
    );
    endRound(reqId, "aborted");
    return;
  }

  setPhase(reqId, "writing");

  const oldSpec = req.spec_md ?? "";
  if (result.new_spec_md !== oldSpec) {
    const revId = createSpecRevision({
      requirement_id: reqId,
      before_md: oldSpec,
      after_md: result.new_spec_md,
      summary: result.summary,
      source: "clarifier",
      triggered_by_question_id: req.active_question_id ?? null,
    });
    updateRequirement(reqId, { spec_md: result.new_spec_md });
    emit({ type: "requirement:spec-revised", payload: { id: reqId, revision_id: revId } });
  }

  // AI 建议新 title（如果与当前不同）
  if (result.new_title && result.new_title !== req.title) {
    updateRequirement(reqId, { title: result.new_title });
    log.info("clarifier: req=%s title 改为 '%s'", reqId, result.new_title);
  }

  if (result.done) {
    setActiveQuestionId(reqId, null);
    setRequirementStatus(reqId, "awaiting_approval");
    log.info("clarifier: req=%s 澄清完成，进入 awaiting_approval", reqId);
    endRound(reqId, "done");
    return;
  }

  if (!result.next_question) {
    log.warn("clarifier: req=%s done=false 但 next_question 为空，跳过", reqId);
    endRound(reqId, "aborted");
    return;
  }
  const qId = nextCommentId();
  createComment({
    id: qId,
    requirement_id: reqId,
    kind: "question",
    from_role: "agent",
    body: result.next_question.agent_text,
    suggestions: result.next_question.suggestions,
    status: "open",
  });
  setActiveQuestionId(reqId, qId);
  emit({ type: "requirement:questions-updated", payload: { id: reqId } });
  log.info("clarifier: req=%s 提出下一个问题 qid=%s", reqId, qId);
  endRound(reqId, "done");
}

// ──────────────────────────────────────────────
// 事件订阅
// ──────────────────────────────────────────────

let _statusHandler: ((event: AutopilotEvent) => void) | null = null;
let _resolvedHandler: ((event: AutopilotEvent) => void) | null = null;

export function initRequirementClarifier(): void {
  if (_statusHandler) return;

  _statusHandler = (event: AutopilotEvent) => {
    if (event.type !== "requirement:status-changed") return;
    const { id, to } = event.payload;
    if (to !== "clarifying") return;
    runClarifierRound(id).catch((e: unknown) => {
      log.error("clarifier: status-changed handler 失败 req=%s: %s", id, (e as Error).message);
    });
  };

  _resolvedHandler = (event: AutopilotEvent) => {
    if (event.type !== "requirement:question-resolved") return;
    const { id } = event.payload;
    const req = getRequirementById(id);
    if (!req || req.status !== "clarifying") return;
    runClarifierRound(id).catch((e: unknown) => {
      log.error("clarifier: question-resolved handler 失败 req=%s: %s", id, (e as Error).message);
    });
  };

  onEvent("requirement:status-changed", _statusHandler);
  onEvent("requirement:question-resolved", _resolvedHandler);
  log.info("requirement-clarifier 已启动（B 模式）");
}

export function disposeRequirementClarifier(): void {
  if (_statusHandler) {
    offEvent("requirement:status-changed", _statusHandler);
    _statusHandler = null;
  }
  if (_resolvedHandler) {
    offEvent("requirement:question-resolved", _resolvedHandler);
    _resolvedHandler = null;
  }
}
