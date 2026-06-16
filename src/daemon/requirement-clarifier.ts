import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { onEvent, offEvent, emit } from "../core/event-bus";
import type { AutopilotEvent } from "./protocol";
import { getRequirementById, updateRequirement, setActiveQuestionId, setRequirementStatus, listRequirementWorkspaces } from "../core/requirements";
import { getProjectById } from "../core/projects";
import type { Workspace } from "../core/sandbox/workspaces";
import {
  createComment,
  nextCommentId,
  listComments,
} from "../core/requirements/comments";
import { createSpecRevision } from "../core/requirements/spec-revisions";
import { createLogger } from "../core/logger";
import {
  startRound,
  setPhase,
  endRound,
} from "./clarifier-progress";
import { buildClarifierAgent } from "./clarifier-agent";
import { parseLlmYamlWrapper } from "../core/llm-yaml";
import { listAttachments, buildAttachmentContext } from "../core/requirements/attachments";
import { ensureRequirementClones } from "../core/requirements/clone";
import { deleteRequirementCodebase } from "../core/sandbox/codebase";
import {
  getSession,
  upsertSession,
  deleteSession,
  type ConversationTurn,
} from "../core/requirements/sessions";
import type { ProviderName } from "../core/config";
import { runWithTaskContext } from "../core/task/context";
import { tmpdir } from "node:os";

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

// C-2 修复：统一返回对象；rawText = 原始 LLM 输出文本，同时用于解析和 snapshot
type ClarifyFn = (
  prompt: string,
  reqId: string,
  sessionRef?: string,
  cwd?: string,
) => Promise<{ rawText: string; newSessionRef?: string }>;

let _clarifyFn: ClarifyFn = callClaude;

export function _setClarifyFnForTest(fn: ClarifyFn | null): void {
  _clarifyFn = fn ?? callClaude;
}

// 测试用：注入替代 buildClarifierAgent 的工厂函数，验证非 Anthropic 路径的 context 注入
// 仅测试使用；生产路径始终用真实 buildClarifierAgent
type BuildAgentFn = typeof buildClarifierAgent;
let _buildAgentFn: BuildAgentFn = buildClarifierAgent;

export function _setBuildAgentFnForTest(fn: BuildAgentFn | null): void {
  _buildAgentFn = fn ?? buildClarifierAgent;
}

/** 测试用：直接调用 callClaude 以验证有 cwd 时的 context 注入逻辑（绕过 _runClarifierRoundInner 的 clone 步骤） */
export const _callClaudeForTest: ClarifyFn = (...args) => callClaude(...args);

async function callClaude(
  prompt: string,
  reqId: string,
  sessionRef?: string,
  cwd?: string,
): Promise<{ rawText: string; newSessionRef?: string }> {
  // 通过 agent 系统调用。merge 顺序：req-level override > 默认 (anthropic + provider 默认 model)
  let agent;
  let resolvedProvider: ProviderName;
  try {
    const req = getRequirementById(reqId);
    const override: { provider?: ProviderName; model?: string } = {};
    if (req?.clarifier_provider) override.provider = req.clarifier_provider as ProviderName;
    if (req?.clarifier_model) override.model = req.clarifier_model;
    agent = _buildAgentFn(override);
    // N-2 修复：从 agent 实例读取实际 provider，避免与 buildClarifierAgent() 内部推导逻辑 desync
    resolvedProvider = (agent.config.provider ?? "anthropic") as ProviderName;
  } catch (e: unknown) {
    throw new Error(`无法初始化 clarifier agent：${e instanceof Error ? e.message : String(e)}`);
  }

  if (resolvedProvider === "anthropic") {
    // Anthropic：chat() 已实现，支持 providerSessionId 续 session。
    // cwd = 需求级浅 clone 根（如有，各库在子目录）：agent 可用读类工具自查代码后再提问
    const result = await agent.chat(prompt, { providerSessionId: sessionRef, cwd });
    const rawText = result.text.trim();
    if (!rawText) throw new Error("clarifier agent 返回空");
    return { rawText, newSessionRef: result.providerSessionId };
  } else {
    // OpenAI/Google：chat() 未实现（base.ts 抛错），沿用 run()，不做 session 跟踪
    // 传入的 sessionRef 被忽略；返回 newSessionRef = undefined
    //
    // API 模式 ensureApiLoop() 需要 task context 中的 sandboxDir（见 agent.ts）。
    // 澄清没有真实 task，用澄清专用占位 taskId，日志落 runtime/tasks/clarify-<reqId>/
    // 不污染真实 task 的 agent-calls.jsonl。
    // cwd 不存在（纯文本模式）时用 tmpdir() 兜底——API loop 仍能初始化，
    // ToolExecutor 的 sandboxRoot 指向系统临时目录（agent 只读 prompt 不需要访问代码）。
    const sandboxDir = cwd ?? tmpdir();
    const result = await runWithTaskContext(
      { taskId: `clarify-${reqId}`, phase: "clarifying", sandboxDir },
      () => agent.run(prompt, cwd ? { cwd } : undefined),
    );
    const rawText = result.text.trim();
    if (!rawText) throw new Error("clarifier agent 返回空");
    return { rawText, newSessionRef: undefined };
  }
}

// ──────────────────────────────────────────────
// Prompt 构造
// ──────────────────────────────────────────────

const REPO_DOC_CANDIDATES = ["CLAUDE.md", "README.md", "README"];

/** 远程文档缓存：澄清是多轮的，避免每轮重复打 gh api（key: ws.id:branch，TTL 10 分钟） */
const remoteDocCache = new Map<string, { at: number; content: string }>();
const REMOTE_DOC_TTL_MS = 10 * 60_000;
const REMOTE_DOC_FETCH_TIMEOUT_MS = 10_000;

function readLocalWorkspaceDocs(workspacePath: string): string {
  const snippets: string[] = [];
  for (const name of REPO_DOC_CANDIDATES) {
    const file = join(workspacePath, name);
    if (existsSync(file)) {
      const content = readFileSync(file, "utf-8").slice(0, 4000);
      snippets.push(`### 自述文档 ${name}\n${content}`);
    }
  }
  return snippets.join("\n\n");
}

/** 本地仓库结构事实：顶层条目清单（目录带 / 后缀；.git 排除，上限 40 项） */
function readLocalStructure(workspacePath: string): string {
  try {
    const entries = readdirSync(workspacePath, { withFileTypes: true })
      .filter((e) => e.name !== ".git")
      .slice(0, 40)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    return entries.length > 0
      ? `### 结构事实（机器采集）\n顶层条目：${entries.join(" ")}`
      : "";
  } catch {
    return "";
  }
}

/** 跑一次 gh，带超时强杀；失败返回 null */
async function runGh(args: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
    const killTimer = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } }, REMOTE_DOC_FETCH_TIMEOUT_MS);
    const exit = await proc.exited;
    clearTimeout(killTimer);
    if (exit !== 0) return null;
    return await new Response(proc.stdout).text();
  } catch {
    return null; // gh 缺失 / 被 kill
  }
}

/** 语言字节数 → "TypeScript 82.3%、CSS 9.1%"（取前 6） */
function formatLanguages(json: Record<string, number>): string {
  const total = Object.values(json).reduce((a, b) => a + b, 0);
  if (!total) return "";
  return Object.entries(json)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k, v]) => `${k} ${((v / total) * 100).toFixed(1)}%`)
    .join("、");
}

/**
 * 按 remote_url 经 gh api 拉仓库上下文（私有库走 gh 凭证；非 GitHub 远程返回空）。
 * 两部分：①结构事实（语言构成 + 顶层目录树——机器采集的客观信号，文档缺失/有错时的兜底）
 * ②自述文档（CLAUDE.md/README 摘录，prompt 里已声明仅作线索）。
 * 失败全静默容错（gh 缺失 / 未登录 / 404 / 网络）——上下文是增益项，不阻塞澄清。
 */
async function fetchRemoteWorkspaceContext(ws: Workspace): Promise<string> {
  let owner = ws.github_owner;
  let repo = ws.github_repo;
  if (!owner || !repo) {
    const m = (ws.remote_url ?? "").match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/);
    if (m) { owner = m[1]; repo = m[2]; }
  }
  if (!owner || !repo) return "";

  const key = `${ws.id}:${ws.default_branch}`;
  const hit = remoteDocCache.get(key);
  if (hit && Date.now() - hit.at < REMOTE_DOC_TTL_MS) return hit.content;

  const sections: string[] = [];

  // ① 结构事实：语言构成 + 顶层目录（并发拉）
  const [langRaw, treeRaw] = await Promise.all([
    runGh(["api", `repos/${owner}/${repo}/languages`]),
    runGh(["api", `repos/${owner}/${repo}/git/trees/${encodeURIComponent(ws.default_branch)}`]),
  ]);
  const factLines: string[] = [];
  if (langRaw) {
    try {
      const langs = formatLanguages(JSON.parse(langRaw) as Record<string, number>);
      if (langs) factLines.push(`语言构成：${langs}`);
    } catch { /* ignore */ }
  }
  if (treeRaw) {
    try {
      const tree = (JSON.parse(treeRaw) as { tree?: Array<{ path: string; type: string }> }).tree ?? [];
      const entries = tree.slice(0, 40).map((e) => (e.type === "tree" ? `${e.path}/` : e.path));
      if (entries.length > 0) factLines.push(`顶层条目：${entries.join(" ")}`);
    } catch { /* ignore */ }
  }
  if (factLines.length > 0) {
    sections.push(`### 结构事实（机器采集）\n${factLines.join("\n")}`);
  }

  // ② 自述文档
  for (const name of REPO_DOC_CANDIDATES) {
    const raw = await runGh([
      "api",
      `repos/${owner}/${repo}/contents/${encodeURIComponent(name)}?ref=${encodeURIComponent(ws.default_branch)}`,
      "-H", "Accept: application/vnd.github.raw",
    ]);
    if (raw && raw.trim()) sections.push(`### 自述文档 ${name}\n${raw.slice(0, 4000)}`);
  }

  const content = sections.join("\n\n");
  // 空结果也缓存：避免对没有这些文档的仓库每轮反复打 404
  remoteDocCache.set(key, { at: Date.now(), content });
  if (content) {
    log.info("clarifier: 已从远程拉取 %s/%s 仓库上下文（%d 字）", owner, repo, content.length);
  }
  return content;
}

/**
 * 仓库快照上下文 —— **仅 clone 失败的降级模式**（clone 就绪时探索交给 agent，不预拼接）。
 * ① 老工作区本地 path → ② 按 remote_url 经 gh api 远程拉（结构事实 + 自述文档）。
 * 结构事实是文档缺失/过期时的客观兜底信号。
 */
async function readWorkspaceContext(ws: Workspace): Promise<string> {
  if (ws.path && existsSync(ws.path)) {
    const parts = [readLocalStructure(ws.path), readLocalWorkspaceDocs(ws.path)].filter(Boolean);
    if (parts.length > 0) return parts.join("\n\n");
  }
  return fetchRemoteWorkspaceContext(ws);
}

function buildPrompt(opts: {
  projectName: string;
  projectDescription: string | null;
  workspaceAliases: string[];
  /** 仓库快照上下文 —— 仅 clone 失败库的降级模式使用（clone 就绪的库不预拼接，探索交给 agent） */
  workspaceContext: string | null;
  /** 需求级 clone 就绪的库（agent cwd = codebase/ 根，各库在子目录）：自主探索（读文件 / 搜索 / git 命令 / 加深历史）。
   *  fidelity=full = 上一轮执行的完整 clone（failed 重澄清场景），停在交付分支、工作树可能有遗留——prompt 如实声明，不静默 reset */
  repoCheckouts: Array<{ dir: string; alias: string; branch: string; fidelity: "shallow" | "full" }>;
  /** clone 失败、仅有远程快照线索的库 alias（在浅克隆段聚合告知） */
  failedAliases: string[];
  title: string;
  specMd: string;
  qaHistory: string;
  attachmentContext: string;
  messagesReplay?: ConversationTurn[];  // session 失效时注入历史对话（与 qaHistory 互斥）
}): string {
  const ctxLines: string[] = [];
  ctxLines.push(`项目名称：${opts.projectName}`);
  if (opts.projectDescription) ctxLines.push(`项目描述：${opts.projectDescription}`);
  if (opts.workspaceAliases.length > 0) ctxLines.push(`关联代码库：${opts.workspaceAliases.join("、")}`);
  if (opts.repoCheckouts.length > 0) {
    const anyFull = opts.repoCheckouts.some((r) => r.fidelity === "full");
    const repoLines = opts.repoCheckouts
      .map((r) => r.fidelity === "full"
        ? `- \`./${r.dir}/\` — ${r.alias}（**完整克隆**，当前停在交付分支 ${r.branch}——本需求上一轮执行的工作分支，` +
          "工作树可能残留上一轮未提交的改动；建议先 `git status` / `git log` 了解现场，不要把它当成 base 分支的最新状态）"
        : `- \`./${r.dir}/\` — ${r.alias}（${r.branch} 分支，浅克隆 depth 1）`)
      .join("\n");
    ctxLines.push("");
    ctxLines.push(
      "## 仓库代码（本地克隆，自主探索）\n" +
      `你的当前工作目录下有本需求关联的 ${opts.repoCheckouts.length} 个仓库的本地克隆` +
      (anyFull
        ? "（浅克隆仅含对应分支的最新提交、没有历史记录；标注「完整克隆」的仓库含完整历史与上一轮执行现场）：\n"
        : "（`git clone --depth 1 --single-branch`，各仓库仅含对应分支的最新提交，没有历史记录）：\n") +
      repoLines + "\n" +
      (opts.failedAliases.length > 0
        ? `\n（以下代码库克隆失败，仅提供「仓库背景」段的远程快照线索：${opts.failedAliases.join("、")}）\n`
        : "") +
      "\n**怎么了解这些项目由你决定**：读任何你认为有价值的文件（README / CLAUDE.md / 源码 / 配置 / 测试）、" +
      "全文搜索、跑 git 命令（注意进入对应仓库子目录再执行）；浅克隆需要提交历史时可以 `git fetch --deepen <N>`" +
      "（或 `--unshallow`）自行加深克隆。\n\n" +
      "目标只有一个：把项目了解到足以提出**精准的问题**——能从代码确认的事实" +
      "（某功能是否存在、入口在哪、技术栈是什么）不要拿去问用户；把提问机会留给代码答不了的部分" +
      "（产品意图、优先级取舍、验收标准）。\n\n" +
      "边界：这是需求级副本，仅供你了解项目——**禁止 push、禁止任何改动远程的操作**；" +
      "也不要修改/还原本地文件（完整克隆的工作树是后续修复轮的工作现场，保持原样）。",
    );
  }
  if (opts.workspaceContext) {
    ctxLines.push("");
    ctxLines.push("## 仓库背景（自动采集）");
    ctxLines.push(
      "> ⚠ 其中「自述文档」是仓库里的 CLAUDE.md/README 摘录，**可能过期、不完整甚至有错**——" +
      "只作背景线索，不要当作事实引用；与用户描述冲突时以用户为准，拿不准的关键前提应当向用户提问验证。" +
      "「结构事实」（语言构成/顶层目录）是机器采集的客观信号，可信度更高。",
    );
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
    // I-1 修复：messagesReplay 段（替换 qaHistory，两段互斥，避免重叠）
    ...(opts.messagesReplay && opts.messagesReplay.length > 0
      ? [
          "",
          "# 上一次澄清会话记录（会话中断，以下为历史对话）",
          "以下是此前澄清会话的完整消息历史，请在此基础上继续：",
          "",
          ...opts.messagesReplay.map((t, i) =>
            `[${t.role === "user" ? "用户输入" : "助手输出"} · 第 ${Math.floor(i / 2) + 1} 轮]\n${t.content}`
          ),
          "",
          "---（历史记录结束）---",
        ]
      : []),
    "",
    "请直接输出 YAML：",
  ].join("\n");
}

// ──────────────────────────────────────────────
// 增量 prompt（session 复用时仅发送新回复 + 继续指令）
// ──────────────────────────────────────────────

function buildIncrementalPrompt(opts: {
  roundNumber: number;   // 当前是第几个 Q&A 轮次（已完成的 Q 数量）
  questionText: string;  // agent 上一轮提的问题
  userReply: string;     // 用户的回答
  currentSpecMd: string; // 当前最新 spec_md（可能被用户手动编辑）
  currentTitle: string;  // 当前需求标题
}): string {
  return [
    `用户已回答第 ${opts.roundNumber} 个问题。`,
    "",
    `问题：${opts.questionText}`,
    `回答：${opts.userReply}`,
    "",
    "当前 spec_md（可能因用户手动修改与你上次看到的不同）：",
    opts.currentSpecMd || "(空)",
    "",
    "当前需求标题：",
    opts.currentTitle,
    "",
    "请根据此回答更新 spec_md，并决定是否需要继续追问。",
    "以相同 YAML 格式输出（字段含义与首轮相同）：",
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
  const workspaces = listRequirementWorkspaces(reqId);

  // 需求级 clone（首轮建、后续轮幂等复用；v2 R4 = 需求 codebase/，与执行同一份）：
  // 拉需求关联的**全集**代码库，agent cwd 指向 codebase/ 根、各库在子目录，
  // 可用读类工具直接查代码验证事实再提问。failed 重澄清可能复用上一轮执行的完整 clone
  //（fidelity=full、停在交付分支脏树）——prompt 如实声明，不静默 reset。
  // 按库降级：clone 成功的库进子目录探索；失败的库走远程快照拼 prompt；全失败退化纯文本（不阻塞）。
  let cloneRoot: string | null = null;
  let clonedRepos: Array<{ ws: Workspace; dir: string; path: string; fidelity: "shallow" | "full"; branch: string }> = [];
  let failedRepos: Workspace[] = [];
  if (workspaces.length > 0) {
    // clone 可能耗时几十秒（首轮），给前端专属阶段而不是让用户以为卡在 LLM 调用
    setPhase(reqId, "cloning-repo");
    try {
      const cloneResult = await ensureRequirementClones(reqId, workspaces);
      clonedRepos = cloneResult.cloned;
      failedRepos = cloneResult.failed;
      if (clonedRepos.length > 0) cloneRoot = cloneResult.root;
    } catch (e: unknown) {
      log.warn("clarifier: 需求级 clone 失败，退化远程快照模式 req=%s: %s",
        reqId, e instanceof Error ? e.message : String(e));
      failedRepos = workspaces;
    }
    setPhase(reqId, "preparing");
  }

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

  // ── ① session 查询 & 消息选择 ─────────────────────────────────────
  const session = getSession(reqId, "clarifying");
  const activeSessionRef = session?.agent_session_ref ?? undefined;

  // N-1 修复：预计算 isAnthropicProvider，用于守卫 replay 触发条件
  // 与 callClaude 内的 resolvedProvider 推导逻辑保持一致：req 级覆盖 > 默认 "anthropic"
  const isAnthropicProvider =
    ((req.clarifier_provider as ProviderName | undefined) ?? "anthropic") === "anthropic";

  // hasPriorQA：本轮前有已解答的问题（= session 里已有先验 Q&A，可走增量路径）
  // 设计前提：每轮最多一个 active question（_inflightRounds 进程内锁 + setActiveQuestionId 保证）
  const hasPriorQA = allQuestionsResolved.length > 0;
  // useIncremental 仅在 Anthropic + 有效 session + 有历史 Q&A 时为 true
  const useIncremental = isAnthropicProvider && !!activeSessionRef && hasPriorQA;

  // ── 增量消息（仅新回复 + 继续指令）────────────────────────────────────
  let incrementalPrompt: string | null = null;
  if (useIncremental) {
    const lastQ = allQuestionsResolved[allQuestionsResolved.length - 1];
    const lastReply = listComments(reqId, { kind: "question", parent_id: lastQ.id })
      .find(r => r.from_role === "user")?.body ?? "(未回复)";
    incrementalPrompt = buildIncrementalPrompt({
      roundNumber: allQuestionsResolved.length,
      questionText: lastQ.body,
      userReply: lastReply,
      currentSpecMd: req.spec_md ?? "",
      currentTitle: req.title,
    });
  }

  // ── 全量 prompt（首轮 / session 失效 fallback）────────────────────────
  // N-1 修复：replay 触发条件加 isAnthropicProvider 守卫
  //   Anthropic + session 失效 + 有 snapshot → 用 replay 替换 qaHistory（互斥，避免重叠）
  //   非 Anthropic（无论是否有 snapshot）→ 始终走 qaHistory 原路径，行为完全不变
  const hasSnapshot = (session?.messages_snapshot?.length ?? 0) > 0;
  const useReplay = isAnthropicProvider && !activeSessionRef && hasSnapshot;

  // clone 失败库的降级快照（远程拉结构事实 + 自述文档，prompt 里已声明可能过期）；
  // clone 就绪的库不预拼接（探索交给 agent 自主）
  let degradedContext: string | null = null;
  if (failedRepos.length > 0) {
    const parts: string[] = [];
    for (const ws of failedRepos) {
      const ctx = await readWorkspaceContext(ws);
      if (ctx) {
        parts.push(workspaces.length > 1 ? `### 代码库 ${ws.alias}\n\n${ctx}` : ctx);
      }
    }
    degradedContext = parts.length > 0 ? parts.join("\n\n") : null;
  }

  const fullPrompt = buildPrompt({
    projectName: project.name,
    projectDescription: project.description,
    workspaceAliases: workspaces.map((w) => w.alias),
    workspaceContext: degradedContext,
    repoCheckouts: clonedRepos.map((c) => ({ dir: c.dir, alias: c.ws.alias, branch: c.branch, fidelity: c.fidelity })),
    failedAliases: failedRepos.map((w) => w.alias),
    title: req.title,
    specMd: req.spec_md ?? "",
    // useReplay 时 qaHistory 传空：历史信息由 messagesReplay 段落承载，两者互斥
    qaHistory: useReplay ? "" : qaHistory,
    attachmentContext,
    messagesReplay: useReplay ? session!.messages_snapshot : [],
  });

  // ── ② 重试循环 ─────────────────────────────────────────────────────
  // 尝试顺序：
  //   有 session + 有 Q&A → [增量+session, 全量+无session]
  //   无 session / 首轮   → [全量+无session, 全量+无session]（保留原 2 次重试语义）
  const attempts: Array<{ prompt: string; sessionRef?: string; label: string }> = [];

  if (useIncremental && incrementalPrompt) {
    attempts.push({ prompt: incrementalPrompt, sessionRef: activeSessionRef, label: "增量+session" });
    attempts.push({ prompt: fullPrompt,        sessionRef: undefined,        label: "全量+新session(fallback)" });
  } else {
    attempts.push({ prompt: fullPrompt, sessionRef: undefined, label: "全量+新session(首轮)" });
    attempts.push({ prompt: fullPrompt, sessionRef: undefined, label: "全量+新session(retry)" });
  }

  let result: ClarifyResult | null = null;
  let lastError: Error | null = null;
  let resolvedSessionRef: string | undefined;
  let resolvedPromptUsed: string = fullPrompt;
  let resolvedRawText = "";   // 原始 LLM 输出文本，用于 snapshot（C-2 修复）

  for (let i = 0; i < attempts.length; i++) {
    const { prompt: attemptPrompt, sessionRef: attemptRef, label } = attempts[i];
    let attemptRaw = "";
    try {
      setPhase(reqId, "calling-llm", { attempt: i as 0 | 1, prompt: attemptPrompt });

      const { rawText, newSessionRef } = await _clarifyFn(attemptPrompt, reqId, attemptRef, cloneRoot ?? undefined);
      attemptRaw = rawText;
      result = parseClarifyResult(rawText);
      resolvedRawText     = rawText;
      resolvedSessionRef  = newSessionRef ?? (attemptRef ?? undefined);
      resolvedPromptUsed  = attemptPrompt;
      break;
    } catch (e: unknown) {
      lastError = e instanceof Error ? e : new Error(String(e));
      log.warn(
        "clarifier: req=%s 第 %d 次（%s）失败: %s%s",
        reqId,
        i + 1,
        label,
        lastError.message,
        attemptRaw ? `；原始输出（前 500 字）: ${attemptRaw.slice(0, 500)}` : "",
      );
      if (i === 0) {
        setPhase(reqId, "parsing", { attempt: 1, last_parse_error: lastError.message });
      }

      // 第一次失败且用了 session → 清除失效 session_ref，下次循环走全量
      if (i === 0 && attemptRef) {
        log.info("clarifier: req=%s session %s 疑似失效，清除 agent_session_ref，下次走全量", reqId, attemptRef);
        upsertSession(reqId, "clarifying", { agent_session_ref: null });
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

  // ── ③ Session 持久化 ─────────────────────────────────────────────
  if (result) {
    // 无论 provider 类型都写 session：
    //   Anthropic  → resolvedSessionRef = "session-xxx"（用于下次 resume）
    //   非 Anthropic → resolvedSessionRef = undefined → agent_session_ref 写 null（snapshot 留存供审计）
    // N-3 修复：直接复用 ① 中已获取的 session 变量，避免重复 DB 查询
    const prevSnapshot = session?.messages_snapshot ?? [];
    const newSnapshot: ConversationTurn[] = [
      ...prevSnapshot,
      { role: "user",      content: resolvedPromptUsed },
      { role: "assistant", content: resolvedRawText },
    ];
    // upsertSession 内部会做 SNAPSHOT_MAX_TURNS 截断
    upsertSession(reqId, "clarifying", {
      agent_session_ref: resolvedSessionRef ?? null,
      messages_snapshot: newSnapshot,
    });
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

    // 终态 → 清理 session（done/cancelled/failed）
    if (to === "done" || to === "cancelled" || to === "failed") {
      deleteSession(id, "clarifying");
    }
    // codebase 清理（v2 R4，spec B）：done 即清（done-workspace-cleanup 负责）；
    // cancelled 仅清纯澄清浅 clone——含 full clone（可能有未交付改动想救回）时留给
    // retention 按需求终态清；failed 整份保留（补约束重试 / fix 续作还要用）
    if (to === "cancelled") {
      try { deleteRequirementCodebase(id, { onlyIfNoFull: true }); } catch { /* 清理失败不阻塞 */ }
    }

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
