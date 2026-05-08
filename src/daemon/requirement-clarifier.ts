import { onEvent, offEvent, emit } from "./event-bus";
import type { AutopilotEvent } from "./protocol";
import { getRequirementById } from "../core/requirements";
import { getProjectById } from "../core/projects";
import { getCodebaseById } from "../core/codebases";
import { createQuestion, nextQuestionId } from "../core/requirement-questions";
import { createAgent } from "../agents/registry";
import { loadProviders } from "../core/config";
import { createLogger } from "../core/logger";

const log = createLogger("requirement-clarifier");

let _handler: ((event: AutopilotEvent) => void) | null = null;

const SYSTEM_PROMPT = `你是一位经验丰富的软件需求分析师。
用户会提供一个需求所属的项目背景，以及需求的标题和规约描述，你需要结合项目背景判断是否有需要澄清的地方，并生成澄清问题。

规则：
- 问题必须结合项目背景，具体且有价值，帮助消除歧义或补充关键缺失信息
- 不要问可以从已有描述中直接推断出答案的问题
- 不要问与项目背景明显无关的泛化问题
- 如果需求已经足够清晰，输出 NO_QUESTIONS
- 每行一个问题，最多 5 个，不要编号、不要 markdown 格式
- 用中文提问`;

function buildPrompt(opts: {
  title: string;
  specMd: string;
  projectName: string;
  projectDescription: string | null;
  codebaseAlias: string | null;
}): string {
  const lines: string[] = [];

  lines.push("【项目背景】");
  lines.push(`项目名称：${opts.projectName}`);
  if (opts.projectDescription) {
    lines.push(`项目描述：${opts.projectDescription}`);
  }
  if (opts.codebaseAlias) {
    lines.push(`关联代码库：${opts.codebaseAlias}`);
  }

  lines.push("");
  lines.push("【需求信息】");
  lines.push(`需求标题：${opts.title}`);
  lines.push("需求规约：");
  lines.push(opts.specMd.trim() || "(暂无规约内容，请根据标题和项目背景判断)");

  lines.push("");
  lines.push("请结合项目背景生成澄清问题（每行一个，最多 5 个）：");

  return lines.join("\n");
}

async function clarifyRequirement(reqId: string): Promise<void> {
  const req = getRequirementById(reqId);
  if (!req || req.status !== "clarifying") return;

  const providers = loadProviders();
  const anthropicCfg = providers["anthropic"];
  if (anthropicCfg?.enabled === false) {
    log.info("clarifier: Anthropic 已禁用，跳过 req=%s", reqId);
    return;
  }

  const model = (anthropicCfg?.default_model as string | undefined) ?? "claude-haiku-4-5-20251001";

  // 拉取项目和代码库信息作为上下文
  const project = req.project_id ? getProjectById(req.project_id) : null;
  const codebase = req.codebase_id ? getCodebaseById(req.codebase_id) : null;

  if (!project) {
    log.warn("clarifier: req=%s 找不到所属项目，跳过", reqId);
    return;
  }

  let agent;
  try {
    agent = createAgent({ name: "clarifier", provider: "anthropic", model, max_turns: 1, permission_mode: "auto" });
  } catch (e: unknown) {
    log.warn("clarifier: 创建 agent 失败 req=%s: %s", reqId, (e as Error).message);
    return;
  }

  try {
    const prompt = buildPrompt({
      title: req.title,
      specMd: req.spec_md ?? "",
      projectName: project.name,
      projectDescription: project.description,
      codebaseAlias: codebase?.alias ?? null,
    });

    const result = await agent.chat(prompt, { system_prompt: SYSTEM_PROMPT });

    const text = result.text?.trim() ?? "";
    if (!text || text === "NO_QUESTIONS") {
      log.info("clarifier: req=%s 无需澄清问题", reqId);
      return;
    }

    const lines = text
      .split("\n")
      .map((l) => l.replace(/^[\d\.\-\*\s]+/, "").trim())
      .filter((l) => l.length > 4);

    let created = 0;
    for (const line of lines.slice(0, 5)) {
      const qId = nextQuestionId();
      createQuestion({ id: qId, requirement_id: reqId, agent_text: line });
      created++;
    }

    if (created > 0) {
      emit({ type: "requirement:questions-updated", payload: { id: reqId } });
      log.info("clarifier: req=%s 生成 %d 个澄清问题", reqId, created);
    }
  } finally {
    await agent.close().catch(() => {});
  }
}

export function initRequirementClarifier(): void {
  if (_handler) return;

  const handler = (event: AutopilotEvent) => {
    if (event.type !== "requirement:status-changed") return;
    const { id, to } = event.payload;
    if (to !== "clarifying") return;

    clarifyRequirement(id).catch((e: unknown) => {
      log.error("clarifier: 澄清失败 req=%s: %s", id, (e as Error).message);
    });
  };

  onEvent("requirement:status-changed", handler);
  _handler = handler;
  log.info("requirement-clarifier 已启动");
}

export function disposeRequirementClarifier(): void {
  if (!_handler) return;
  offEvent("requirement:status-changed", _handler);
  _handler = null;
}
