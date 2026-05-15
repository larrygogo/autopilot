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
import { parseLooseJson } from "../core/llm-json";
import { buildClarifierAgent } from "./clarifier-agent";

const log = createLogger("workflow-author");

const AUTHOR_SYSTEM_PROMPT = `你是 autopilot 工作流作者。

工作流由 workflow.yaml 组成；只有复杂场景才需要 workflow.ts。yaml 结构：

\`\`\`yaml
name: <短名>             # 标识符（snake_case 英文）
label: <显示名>          # 中文（或用户描述用的语言）显示名，UI 上替代 name
description: <一句话用例说明>
agents:                  # 可选；不写则用全局内置 coder/reviewer
  - name: coder
    label: 编码助手      # 可选；agent 显示名
    extends: coder
phases:
  - name: <phase 名>     # snake_case 英文标识符
    label: <显示名>      # 中文显示名（如 "设计"、"代码评审"）
    agent: coder         # 引用 agents[] 里某条 .name；不写默认 coder
    timeout: 900         # 秒
    prompt: |            # ⭐ 强烈优先用 prompt 字段（零代码模式）
      你是一位...        # 框架会自动 getAgent(agent).run(prompt)
      \${REQUIREMENT}    # 可用变量：\${TASK_TITLE} \${REQUIREMENT} \${WORKSPACE} \${PHASE}
    # 可选 gate: true → 此 phase 完成后挂起等用户审批
    # 可选 reject: <某个早期 phase 名> → 用于"驳回到上游"
\`\`\`

⭐ **优先使用 prompt 字段（零代码模式）**：

简单的"调 agent 跑一段 prompt"场景（写作、翻译、改写、总结、单轮分析、生成代码方案、
评审报告等），都应该直接在 yaml 写 prompt 字段。框架会自动调用 agent.run(prompt)，
**不需要写 workflow.ts**。这是最常见的工作流场景。

变量占位符：
- \${TASK_TITLE} — 任务标题
- \${REQUIREMENT} — 用户提的需求详情
- \${WORKSPACE} — 任务的工作目录路径
- \${PHASE} — 当前 phase 名
- \${TASK.field} — 任务上 setup_func 留下的任意字段

只有以下场景才需要写 workflow.ts：
- phase 内部需要解析 agent 返回结论决定走 pass/reject 分支
- 需要 git / 命令行 / 文件系统等复杂 IO
- 需要在 phase 内自己调状态机 transition
- 多 agent 互动 / 链式调用

如果用户描述需要这些，那就在 ts 字段里写完整的 \`run_<phase>(taskId)\` 函数；
否则 ts 字段应该是空字符串 ""。

注意：
- name 字段必须是 snake_case 英文标识符
- label 字段是给人看的中文显示名（UI 上显示）；用户描述用什么语言就用什么语言
- 工作流顶层、每个 phase、每个 agent 都要尽量填 label

读用户描述（可能含 prior_yaml / prior_ts 表示要在原基础上增量调整）。

**只输出严格 JSON**，含字段：
  - name: string（snake_case 短名，例 "backend_dev"）
  - description: string（一句话用例）
  - yaml: string（完整 yaml 文本，简单场景用 prompt 字段）
  - ts: string（complex 场景下完整 ts；零代码场景填空字符串 ""）

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
    // 用 parseLooseJson 而不是 JSON.parse — LLM 经常无视"不要 ```json 围栏"指令
    parsed = parseLooseJson(raw);
  } catch (e: unknown) {
    log.warn("AI 返回非法 JSON：%s", e instanceof Error ? e.message : String(e));
    return fallback(input, "AI 返回非法 JSON");
  }

  if (typeof parsed.yaml !== "string" || !parsed.yaml.trim()) {
    return fallback(input, "缺 yaml 字段");
  }
  // ts 字段允许为空字符串（零代码模式：所有 phase 都用 prompt）
  if (typeof parsed.ts !== "string") {
    return fallback(input, "ts 字段必须是字符串（空字符串表示零代码模式）");
  }

  // yaml 合法性
  const warnings: string[] = [];
  let parsedYaml: Record<string, unknown> | null = null;
  try {
    parsedYaml = parseYaml(parsed.yaml) as Record<string, unknown>;
  } catch (e: unknown) {
    warnings.push(`yaml 解析失败：${e instanceof Error ? e.message : String(e)}`);
  }

  // 每个 phase 必须满足：要么 yaml 里有 prompt 字段，要么 ts 里有对应的 run_<name>
  // 否则 phase 跑不起来
  const phases: Array<{ name: string; hasPrompt: boolean }> = [];
  if (parsedYaml && Array.isArray(parsedYaml.phases)) {
    for (const p of parsedYaml.phases as Array<Record<string, unknown>>) {
      if (!p || typeof p !== "object") continue;
      // 展开并行块
      if (p.parallel && typeof p.parallel === "object") {
        const par = p.parallel as Record<string, unknown>;
        const subs = Array.isArray(par.phases) ? (par.phases as Array<Record<string, unknown>>) : [];
        for (const s of subs) {
          if (typeof s.name === "string") {
            phases.push({
              name: s.name,
              hasPrompt: typeof s.prompt === "string" && s.prompt.trim() !== "",
            });
          }
        }
      } else if (typeof p.name === "string") {
        phases.push({
          name: p.name,
          hasPrompt: typeof p.prompt === "string" && p.prompt.trim() !== "",
        });
      }
    }
  }
  const tsText = parsed.ts;
  for (const { name: ph, hasPrompt } of phases) {
    if (hasPrompt) continue; // prompt 路径不需要 ts 函数
    const re = new RegExp(`export\\s+(async\\s+)?function\\s+${ph}\\b`);
    if (!re.test(tsText)) {
      warnings.push(`阶段 ${ph} 既无 prompt 字段也无 ts 函数 export，会跑不起来`);
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
  // 零代码工作流（ts 为空）就不创建 workflow.ts 文件，避免误导用户去看一个空文件
  if (ts.trim()) {
    writeFileSync(join(dir, "workflow.ts"), ts, "utf-8");
  }
}
