import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { onEvent, offEvent, emit } from "./event-bus";
import type { AutopilotEvent } from "./protocol";
import { getRequirementById } from "../core/requirements";
import { getProjectById } from "../core/projects";
import { getCodebaseById } from "../core/codebases";
import { createQuestion, nextQuestionId } from "../core/requirement-questions";
import { createLogger } from "../core/logger";

const log = createLogger("requirement-clarifier");

let _handler: ((event: AutopilotEvent) => void) | null = null;

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
  title: string;
  specMd: string;
  projectName: string;
  projectDescription: string | null;
  codebaseAlias: string | null;
  codebaseContext: string | null;
}): string {
  const lines: string[] = [];
  lines.push("你是一位软件需求分析师。根据项目背景和需求信息，生成澄清问题。");
  lines.push("规则：每行一个问题，最多 5 个，不要编号，不要 markdown，不要任何前言或解释，");
  lines.push("问题必须结合项目实际情况具体有价值，如果需求已足够清晰则只输出 NO_QUESTIONS。");
  lines.push("");
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
  lines.push(`需求规约：${opts.specMd.trim() || "(暂无)"}`);
  lines.push("");
  lines.push("请生成澄清问题（每行一个，最多5个，直接输出问题）：");
  return lines.join("\n");
}

async function callClaude(prompt: string): Promise<string> {
  const proc = Bun.spawn(
    ["claude", "-p", prompt, "--output-format", "text", "--tools", ""],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, _] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return stdout.trim();
}

async function clarifyRequirement(reqId: string): Promise<void> {
  const req = getRequirementById(reqId);
  if (!req || req.status !== "clarifying") return;

  const project = req.project_id ? getProjectById(req.project_id) : null;
  if (!project) {
    log.warn("clarifier: req=%s 找不到所属项目，跳过", reqId);
    return;
  }
  const codebase = req.codebase_id ? getCodebaseById(req.codebase_id) : null;

  const codebasePath = codebase?.path ?? null;
  const codebaseContext = codebasePath ? readCodebaseContext(codebasePath) : null;
  const prompt = buildPrompt({
    title: req.title,
    specMd: req.spec_md ?? "",
    projectName: project.name,
    projectDescription: project.description,
    codebaseAlias: codebase?.alias ?? null,
    codebaseContext,
  });

  let text: string;
  try {
    text = await callClaude(prompt);
  } catch (e: unknown) {
    log.warn("clarifier: claude CLI 调用失败 req=%s: %s", reqId, (e as Error).message);
    return;
  }

  if (!text || text === "NO_QUESTIONS") {
    log.info("clarifier: req=%s 无需澄清问题", reqId);
    return;
  }

  const lines = text
    .split("\n")
    .map((l) => l.replace(/^[\d\.\-\*\s]+/, "").trim())
    .filter((l) => l.length > 4 && !l.startsWith("#"));

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
