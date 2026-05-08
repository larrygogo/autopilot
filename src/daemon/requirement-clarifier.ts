import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { onEvent, offEvent, emit } from "./event-bus";
import type { AutopilotEvent } from "./protocol";
import { getRequirementById } from "../core/requirements";
import { getProjectById } from "../core/projects";
import { getCodebaseById } from "../core/codebases";
import { listQuestionsByRequirement, createQuestion, nextQuestionId } from "../core/requirement-questions";
import { createLogger } from "../core/logger";

const log = createLogger("requirement-clarifier");

let _statusHandler: ((event: AutopilotEvent) => void) | null = null;
let _resolvedHandler: ((event: AutopilotEvent) => void) | null = null;

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

async function callClaude(prompt: string): Promise<string> {
  const proc = Bun.spawn(
    ["claude", "-p", prompt, "--output-format", "text", "--tools", ""],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return stdout.trim();
}

function buildContext(opts: {
  projectName: string;
  projectDescription: string | null;
  codebaseAlias: string | null;
  codebaseContext: string | null;
  title: string;
  specMd: string;
}): string {
  const lines: string[] = [];
  lines.push(`项目名称：${opts.projectName}`);
  if (opts.projectDescription) lines.push(`项目描述：${opts.projectDescription}`);
  if (opts.codebaseAlias) lines.push(`关联代码库：${opts.codebaseAlias}`);
  if (opts.codebaseContext) {
    lines.push("");
    lines.push("## 代码库文档");
    lines.push(opts.codebaseContext);
  }
  lines.push("");
  lines.push(`需求标题：${opts.title}`);
  if (opts.specMd.trim()) {
    lines.push(`需求规约：${opts.specMd.trim()}`);
  }
  return lines.join("\n");
}

/** 第一轮：需求刚进入 clarifying，生成初始问题 */
async function runFirstRound(reqId: string): Promise<void> {
  const req = getRequirementById(reqId);
  if (!req || req.status !== "clarifying") return;

  const project = req.project_id ? getProjectById(req.project_id) : null;
  if (!project) { log.warn("clarifier: req=%s 找不到项目，跳过", reqId); return; }
  const codebase = req.codebase_id ? getCodebaseById(req.codebase_id) : null;

  const ctx = buildContext({
    projectName: project.name,
    projectDescription: project.description,
    codebaseAlias: codebase?.alias ?? null,
    codebaseContext: codebase?.path ? readCodebaseContext(codebase.path) : null,
    title: req.title,
    specMd: req.spec_md ?? "",
  });

  const prompt =
    "你是一位软件需求分析师。根据以下项目背景和需求，生成澄清问题。\n" +
    "规则：\n" +
    "- 每行一个问题，不要编号、不要 markdown 标记、不要前言\n" +
    "- 每个问题下一行可选输出建议选项，格式：「建议：选项A | 选项B | 选项C」（2-4个短选项）\n" +
    "- 问题必须结合项目实际情况有价值\n" +
    "- 如果需求已足够清晰无需提问，只输出 NO_QUESTIONS\n\n" +
    ctx + "\n\n请生成澄清问题：";

  const text = await callClaude(prompt).catch((e: unknown) => {
    log.warn("clarifier: 第一轮调用失败 req=%s: %s", reqId, (e as Error).message);
    return "";
  });

  if (!text || text === "NO_QUESTIONS") {
    log.info("clarifier: req=%s 首轮无需澄清", reqId);
    return;
  }

  const questions = parseQuestions(text);
  createQuestions(reqId, questions);
  if (questions.length > 0) {
    emit({ type: "requirement:questions-updated", payload: { id: reqId } });
    log.info("clarifier: req=%s 第一轮生成 %d 个问题", reqId, questions.length);
  }
}

/**
 * 后续轮：所有问题都回答完后，AI 决定：
 * - 继续追问 → 输出新问题（每行一个）
 * - 结束 → 输出 CLARIFICATION_COMPLETE，紧跟整理好的 spec_md
 */
async function runFollowUpRound(reqId: string): Promise<void> {
  const req = getRequirementById(reqId);
  if (!req || req.status !== "clarifying") return;

  const project = req.project_id ? getProjectById(req.project_id) : null;
  if (!project) return;
  const codebase = req.codebase_id ? getCodebaseById(req.codebase_id) : null;

  const allQuestions = listQuestionsByRequirement(reqId);
  const qaHistory = allQuestions.map((q, i) => {
    const userReply = (q.replies ?? []).find(r => r.author_role === "user")?.text ?? "(未回复)";
    return `问题 ${i + 1}：${q.agent_text}\n回答：${userReply}`;
  }).join("\n\n");

  const ctx = buildContext({
    projectName: project.name,
    projectDescription: project.description,
    codebaseAlias: codebase?.alias ?? null,
    codebaseContext: codebase?.path ? readCodebaseContext(codebase.path) : null,
    title: req.title,
    specMd: req.spec_md ?? "",
  });

  const prompt =
    "你是一位软件需求分析师，正在与用户进行需求澄清对话。\n\n" +
    ctx + "\n\n" +
    "## 已完成的澄清问答\n\n" + qaHistory + "\n\n" +
    "请根据以上回答判断：\n" +
    "- 如果还需要进一步澄清，输出追加问题（每行一个问题，问题下一行可选附「建议：选项A | 选项B」，不要编号、不要 markdown）。\n" +
    "- 如果信息已经足够，输出以下格式（第一行必须是 CLARIFICATION_COMPLETE，之后另起段落写对需求的理解摘要）：\n" +
    "CLARIFICATION_COMPLETE\n" +
    "（摘要：用 2-4 句话概括你对需求的理解，让用户确认是否有遗漏）";

  const text = await callClaude(prompt).catch((e: unknown) => {
    log.warn("clarifier: 追问调用失败 req=%s: %s", reqId, (e as Error).message);
    return "";
  });

  if (!text) return;

  if (text.includes("CLARIFICATION_COMPLETE")) {
    const summary = text.split("CLARIFICATION_COMPLETE").slice(1).join("").trim();
    const confirmText = summary
      ? `根据我们的讨论，我对需求的理解如下：\n\n${summary}\n\n请确认是否有遗漏或需要补充。没有的话可以点击「标记为已澄清」继续。`
      : "我认为需求信息已足够，请问还有什么需要补充的吗？没有的话可以点击「标记为已澄清」继续。";
    const qId = nextQuestionId();
    createQuestion({ id: qId, requirement_id: reqId, agent_text: confirmText });
    emit({ type: "requirement:questions-updated", payload: { id: reqId } });
    log.info("clarifier: req=%s 已发送确认摘要，等待用户确认", reqId);
    return;
  }

  // 还有追问
  const questions = parseQuestions(text);
  createQuestions(reqId, questions);
  if (questions.length > 0) {
    emit({ type: "requirement:questions-updated", payload: { id: reqId } });
    log.info("clarifier: req=%s 追问 %d 个问题", reqId, questions.length);
  }
}

interface ParsedQuestion {
  text: string;
  suggestions: string[];
}

function parseQuestions(text: string): ParsedQuestion[] {
  const lines = text.split("\n");
  const results: ParsedQuestion[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].replace(/^[\d\.\-\*\s]+/, "").trim();
    if (line.length > 4 && !line.startsWith("#") && !line.startsWith("CLARIFICATION")) {
      const next = lines[i + 1]?.trim() ?? "";
      let suggestions: string[] = [];
      if (next.startsWith("建议：") || next.startsWith("选项：")) {
        suggestions = next.replace(/^(建议|选项)：/, "").split("|").map(s => s.trim()).filter(Boolean);
        i++;
      }
      results.push({ text: line, suggestions });
    }
    i++;
  }
  return results;
}

function createQuestions(reqId: string, questions: ParsedQuestion[]): void {
  for (const q of questions) {
    const qId = nextQuestionId();
    createQuestion({ id: qId, requirement_id: reqId, agent_text: q.text, suggestions: q.suggestions });
  }
}

export function initRequirementClarifier(): void {
  if (_statusHandler) return;

  _statusHandler = (event: AutopilotEvent) => {
    if (event.type !== "requirement:status-changed") return;
    const { id, to } = event.payload;
    if (to !== "clarifying") return;
    runFirstRound(id).catch((e: unknown) => {
      log.error("clarifier: 第一轮失败 req=%s: %s", id, (e as Error).message);
    });
  };

  _resolvedHandler = (event: AutopilotEvent) => {
    if (event.type !== "requirement:all-questions-resolved") return;
    const { id } = event.payload;
    runFollowUpRound(id).catch((e: unknown) => {
      log.error("clarifier: 追问失败 req=%s: %s", id, (e as Error).message);
    });
  };

  onEvent("requirement:status-changed", _statusHandler);
  onEvent("requirement:all-questions-resolved", _resolvedHandler);
  log.info("requirement-clarifier 已启动");
}

export function disposeRequirementClarifier(): void {
  if (_statusHandler) { offEvent("requirement:status-changed", _statusHandler); _statusHandler = null; }
  if (_resolvedHandler) { offEvent("requirement:all-questions-resolved", _resolvedHandler); _resolvedHandler = null; }
}
