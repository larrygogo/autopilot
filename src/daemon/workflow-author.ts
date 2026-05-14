/**
 * 工作流 AI 作者：用户用自然语言描述要做什么 → AI 生成 workflow.yaml + workflow.ts。
 *
 * 跟 PR #65 extract 同模式：复用 clarifier agent 系统，传专用 system_prompt。
 * 半轮生成 + 允许追问调整（带上 prior_yaml / prior_ts 让 AI 增量改）。
 *
 * 永不抛——LLM 失败 / 非法 JSON / 缺字段 → 兜底返回 stub 让用户至少有起点。
 */

import { existsSync, mkdirSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { parse as parseYaml } from "yaml";
import { createLogger } from "../core/logger";
import { buildClarifierAgent } from "./clarifier-agent";

const log = createLogger("workflow-author");

const AUTHOR_SYSTEM_PROMPT = `你是 autopilot 工作流作者。

工作流由 workflow.yaml 和 workflow.ts 组成。yaml 结构：

\`\`\`yaml
name: <短名>
description: <一句话用例说明>
agents:                # 可选；不写则用全局内置 coder/reviewer
  - name: coder
    extends: coder
phases:
  - name: <phase 名>
    agent: coder       # 引用 agents[] 里某条 .name；不写默认 coder
    timeout: 900       # 秒
    # 可选 gate: true → 此 phase 完成后挂起等用户审批
    # 可选 reject: <某个早期 phase 名> → 用于"驳回到上游"
\`\`\`

workflow.ts 必须对每个 phase 导出同名 async function：

\`\`\`ts
export async function <phase_name>(taskId: string): Promise<void> {
  // TODO: 用 getAgent("coder", "<workflow_name>").run(prompt) 调 AI
  // TODO: 或自己写 IO/git 操作
}
\`\`\`

读用户描述（可能含 prior_yaml / prior_ts 表示要在原基础上增量调整）。

**只输出严格 JSON**，含字段：
  - name: string（snake_case 短名，例 "backend_dev"）
  - description: string（一句话用例）
  - yaml: string（完整 yaml 文本）
  - ts: string（完整 ts 文本，每个 phase 一个 stub 函数）

不要解释、不要 \`\`\`json 围栏。`;

export interface AuthorInput {
  description: string;
  prior_yaml?: string;
  prior_ts?: string;
}

export interface AuthorResult {
  name: string;
  description: string;
  yaml: string;
  ts: string;
  warnings: string[];
}

type AuthorFn = (prompt: string) => Promise<string>;
let _authorFn: AuthorFn = callClaudeForAuthor;

export function _setAuthorFnForTest(fn: AuthorFn | null): void {
  _authorFn = fn ?? callClaudeForAuthor;
}

async function callClaudeForAuthor(prompt: string): Promise<string> {
  const agent = buildClarifierAgent();
  const result = await agent.run(prompt, { system_prompt: AUTHOR_SYSTEM_PROMPT });
  return result.text ?? "";
}

function buildPrompt(input: AuthorInput): string {
  let p = `用户描述：\n${input.description}`;
  if (input.prior_yaml || input.prior_ts) {
    p += "\n\n上一版 yaml：\n```yaml\n" + (input.prior_yaml ?? "") + "\n```";
    p += "\n\n上一版 ts：\n```ts\n" + (input.prior_ts ?? "") + "\n```";
    p += "\n\n请在上一版基础上按用户描述调整。";
  }
  return p;
}

function fallback(input: AuthorInput, reason: string): AuthorResult {
  const name = "new_workflow";
  const description = input.description.slice(0, 60);
  const yaml = `# AI 生成失败：${reason}
# 请手工填写或重新生成
name: ${name}
description: ${JSON.stringify(description)}
phases:
  - name: do_it
    agent: coder
    timeout: 900
`;
  const ts = `// AI 生成失败：${reason}
export async function do_it(_taskId: string): Promise<void> {
  // TODO: ${description}
}
`;
  return { name, description, yaml, ts, warnings: [`AI 生成失败：${reason}`] };
}

export async function runWorkflowAuthor(input: AuthorInput): Promise<AuthorResult> {
  let raw: string;
  try {
    raw = await _authorFn(buildPrompt(input));
  } catch (e: unknown) {
    log.warn("AI 调用失败：%s", e instanceof Error ? e.message : String(e));
    return fallback(input, e instanceof Error ? e.message : String(e));
  }

  let parsed: { name?: unknown; description?: unknown; yaml?: unknown; ts?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn("AI 返回非法 JSON");
    return fallback(input, "AI 返回非法 JSON");
  }

  if (typeof parsed.yaml !== "string" || !parsed.yaml.trim()) {
    return fallback(input, "缺 yaml 字段");
  }
  if (typeof parsed.ts !== "string" || !parsed.ts.trim()) {
    return fallback(input, "缺 ts 字段");
  }

  // yaml 合法性
  const warnings: string[] = [];
  let parsedYaml: Record<string, unknown> | null = null;
  try {
    parsedYaml = parseYaml(parsed.yaml) as Record<string, unknown>;
  } catch (e: unknown) {
    warnings.push(`yaml 解析失败：${e instanceof Error ? e.message : String(e)}`);
  }

  // ts 必须导出 phase 同名函数
  const phaseNames: string[] = [];
  if (parsedYaml && Array.isArray(parsedYaml.phases)) {
    for (const p of parsedYaml.phases as Array<{ name?: string }>) {
      if (p && typeof p.name === "string") phaseNames.push(p.name);
    }
  }
  const tsText = parsed.ts;
  for (const phase of phaseNames) {
    const re = new RegExp(`export\\s+(async\\s+)?function\\s+${phase}\\b`);
    if (!re.test(tsText)) {
      warnings.push(`ts 缺函数 export：${phase}`);
    }
  }

  const name = typeof parsed.name === "string" && /^[\w.\-]+$/.test(parsed.name)
    ? parsed.name
    : "new_workflow";
  const description = typeof parsed.description === "string"
    ? parsed.description
    : input.description.slice(0, 60);

  return {
    name,
    description,
    yaml: parsed.yaml,
    ts: tsText,
    warnings,
  };
}

/**
 * 把生成的 yaml + ts 落到 ~/.autopilot/workflows/<name>/。
 * 名字非法 / 目标已存在 → 抛错。
 */
export function saveAuthoredWorkflow(name: string, yaml: string, ts: string): void {
  if (!/^[\w.\-]+$/.test(name)) {
    throw new Error("name 只允许字母 / 数字 / . _ -");
  }
  const home = process.env.AUTOPILOT_HOME || join(homedir(), ".autopilot");
  const dir = join(home, "workflows", name);
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new Error("target workflow already exists");
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "workflow.yaml"), yaml, "utf-8");
  writeFileSync(join(dir, "workflow.ts"), ts, "utf-8");
}
