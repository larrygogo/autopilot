import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { onEvent, offEvent, emit } from "./event-bus";
import type { AutopilotEvent } from "./protocol";
import { getRequirementById, updateRequirement, setActiveQuestionId, setRequirementStatus } from "../core/requirements";
import { getProjectById } from "../core/projects";
import { getCodebaseById } from "../core/codebases";
import { createQuestion, nextQuestionId, listQuestionsByRequirement } from "../core/requirement-questions";
import { createSpecRevision } from "../core/spec-revisions";
import { createLogger } from "../core/logger";
import { resolveAgentConfig, createAgent } from "../agents/registry";
import { loadGlobalAgents, loadProviders } from "../core/config";

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

type ClarifyFn = (prompt: string) => Promise<string>;

let _clarifyFn: ClarifyFn = callClaude;

export function _setClarifyFnForTest(fn: ClarifyFn | null): void {
  _clarifyFn = fn ?? callClaude;
}

async function callClaude(prompt: string): Promise<string> {
  // 通过 agent 系统调用。agent name 固定为 'clarifier'；
  // 用户在 config.yaml.agents.clarifier 配 provider/model/system_prompt。
  // 没配 clarifier 也能跑 — registry 会用全局默认（anthropic + default model）。
  let agent;
  try {
    const globalAgents = loadGlobalAgents();
    const providers = loadProviders();
    // 若用户没有配置 clarifier，使用 anthropic 作为默认 provider
    const base = globalAgents["clarifier"] ?? { provider: "anthropic" };
    const resolved = resolveAgentConfig("clarifier", undefined, { clarifier: base }, providers);
    agent = createAgent(resolved);
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

function readCodebaseContext(codebasePath: string): string {
  const candidates = ["CLAUDE.md", "README.md", "README"];
  const snippets: string[] = [];
  for (const name of candidates) {
    const file = join(codebasePath, name);
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
  codebaseAlias: string | null;
  codebaseContext: string | null;
  title: string;
  specMd: string;
  qaHistory: string;
}): string {
  const ctxLines: string[] = [];
  ctxLines.push(`项目名称：${opts.projectName}`);
  if (opts.projectDescription) ctxLines.push(`项目描述：${opts.projectDescription}`);
  if (opts.codebaseAlias) ctxLines.push(`关联代码库：${opts.codebaseAlias}`);
  if (opts.codebaseContext) {
    ctxLines.push("");
    ctxLines.push("## 代码库文档");
    ctxLines.push(opts.codebaseContext);
  }

  return [
    "你是一位软件需求分析师，正在持续优化一份需求规约（spec_md）并一问一答地澄清需求。",
    "",
    "# 任务",
    "1. 根据当前 spec_md 和已有 Q&A 历史，**精确修订** spec_md：",
    "   - 保留原文中正确的内容（不要重写整篇）",
    "   - 只改不对的、只加缺失的、只删冗余的",
    "   - 不要包裹 ``` 代码块",
    "2. 决定下一个最该问的问题，或宣告澄清完成。",
    "",
    "# 输出格式（严格 JSON，不要任何前后多余文本）",
    '{',
    '  "new_spec_md": "...",        // 修订后的完整 spec_md',
    '  "summary": "...",             // 本轮修订摘要（短，1-2 句），null 表示无变化',
    '  "next_question": {',
    '    "agent_text": "...",        // 下一个问题',
    '    "suggestions": ["A","B"]   // 2-4 个短选项，可空数组',
    '  } | null,                     // null 表示不再追问',
    '  "done": true|false,           // true=信息已足够、可入队',
    '  "new_title": "..." | null      // 改进后的需求标题（10-20 字），null 表示当前标题已足够好',
    '}',
    "",
    "# 关键规则",
    "- 如果 spec_md 没变化，new_spec_md 仍要原样输出，但 summary 可为 null。",
    "- 下一个问题必须**基于最新 spec_md 和已有 Q&A**，不要重复问已澄清的事。",
    "- 如果信息已足够实现需求，输出 done=true 且 next_question=null。",
    "- 标题（title）应该一句话概括需求；如果当前 title 看起来是用户直接从描述粗截的（如带省略号、半句话、过长），用 new_title 给出更好的版本。如果当前 title 已经准确，new_title 为 null。",
    "- 输出**只有 JSON**，前后没有任何 markdown / 解释 / 代码块。",
    "",
    "# 上下文",
    ctxLines.join("\n"),
    "",
    "# 需求标题",
    opts.title,
    "",
    "# 当前 spec_md",
    opts.specMd || "(空)",
    "",
    opts.qaHistory ? "# 已完成的 Q&A 历史\n\n" + opts.qaHistory : "# 已完成的 Q&A 历史\n\n(暂无)",
    "",
    "请直接输出 JSON：",
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
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
  }
  const parsed = JSON.parse(text) as Record<string, unknown>;
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

export async function runClarifierRound(reqId: string): Promise<void> {
  if (_inflightRounds.has(reqId)) {
    log.info("clarifier: req=%s 已在跑，跳过重复 trigger", reqId);
    return;
  }
  _inflightRounds.add(reqId);
  try {
    await _runClarifierRoundInner(reqId);
  } finally {
    _inflightRounds.delete(reqId);
  }
}

async function _runClarifierRoundInner(reqId: string): Promise<void> {
  const req = getRequirementById(reqId);
  if (!req || req.status !== "clarifying") return;

  const project = req.project_id ? getProjectById(req.project_id) : null;
  if (!project) {
    log.warn("clarifier: req=%s 找不到项目，跳过", reqId);
    return;
  }
  const codebase = req.codebase_id ? getCodebaseById(req.codebase_id) : null;

  // 开始新一轮：清除上次的错误（如果有）
  if (req.clarifier_error) {
    updateRequirement(reqId, { clarifier_error: null });
  }

  const allQuestions = listQuestionsByRequirement(reqId);
  const qaHistory = allQuestions
    .filter(q => q.status === "resolved")
    .map((q, i) => {
      const userReply = (q.replies ?? []).find(r => r.author_role === "user")?.text ?? "(未回复)";
      return `Q${i + 1}：${q.agent_text}\nA${i + 1}：${userReply}`;
    }).join("\n\n");

  const prompt = buildPrompt({
    projectName: project.name,
    projectDescription: project.description,
    codebaseAlias: codebase?.alias ?? null,
    codebaseContext: codebase?.path ? readCodebaseContext(codebase.path) : null,
    title: req.title,
    specMd: req.spec_md ?? "",
    qaHistory,
  });

  let result: ClarifyResult | null = null;
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await _clarifyFn(prompt);
      result = parseClarifyResult(raw);
      break;
    } catch (e: unknown) {
      lastError = e instanceof Error ? e : new Error(String(e));
      log.warn("clarifier: req=%s 第 %d 次解析失败: %s", reqId, attempt + 1, lastError.message);
    }
  }

  if (!result) {
    const reason = lastError?.message ?? "unknown error";
    updateRequirement(reqId, { clarifier_error: reason });
    emit({
      type: "requirement:clarifier-error",
      payload: { id: reqId, reason },
    });
    return;
  }

  // Race protection: status may have changed (e.g. user called finish-clarification)
  // between the initial check and the AI response. Re-fetch and abort if no longer clarifying.
  const reqAfter = getRequirementById(reqId);
  if (!reqAfter || reqAfter.status !== "clarifying") {
    log.info("clarifier: req=%s 状态已变（%s），AI 结果丢弃", reqId, reqAfter?.status ?? "deleted");
    return;
  }

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
    return;
  }

  if (!result.next_question) {
    log.warn("clarifier: req=%s done=false 但 next_question 为空，跳过", reqId);
    return;
  }
  const qId = nextQuestionId();
  createQuestion({
    id: qId,
    requirement_id: reqId,
    agent_text: result.next_question.agent_text,
    suggestions: result.next_question.suggestions,
  });
  setActiveQuestionId(reqId, qId);
  emit({ type: "requirement:questions-updated", payload: { id: reqId } });
  log.info("clarifier: req=%s 提出下一个问题 qid=%s", reqId, qId);
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
