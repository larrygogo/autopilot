/**
 * 工作流 AI 作者：用户用自然语言描述要做什么 → AI 生成 workflow.yaml + workflow.ts。
 *
 * 跟 PR #65 extract 同模式：复用 clarifier agent 系统，传专用 system_prompt。
 * 半轮生成 + 允许追问调整（带上 prior_yaml / prior_ts 让 AI 增量改）。
 *
 * 永不抛——LLM 失败 / 非法 JSON / 缺字段 → 兜底返回 stub 让用户至少有起点。
 */

import { parse as parseYaml } from "yaml";
import { createLogger } from "../core/logger";
import { parseLlmYamlWrapper } from "../core/llm-yaml";
import { buildClarifierAgent } from "./clarifier-agent";
import { createNativeDbWorkflow } from "../core/workflow/workflows";
import { parseWorkflowText, stringifyWorkflowDoc } from "../core/workflow/serialize";
import { WORKFLOW_NAME_RE } from "../core/workflow/registry";

const log = createLogger("workflow-author");

const AUTHOR_SYSTEM_PROMPT = `你是 autopilot 工作流作者。autopilot 工作流是**纯声明式数据**——只写 yaml 声明，
**绝不写任何代码（无 workflow.ts、无 run_ 函数）**。所有能力都由框架内置原语提供，你只负责声明。

工作流 yaml 结构：

\`\`\`yaml
name: <短名>             # snake_case 英文标识符
label: <显示名>          # 中文（或用户描述用的语言）显示名，UI 上替代 name
description: <一句话用例说明>
phases:
  - name: <phase 名>     # snake_case 英文标识符
    label: <显示名>      # 中文显示名（如 "设计"、"代码评审"）
    agent:               # 可选；内联配置该 phase 的 agent，省略则用默认 agent
      provider: anthropic
      model: claude-sonnet-4-6
      system_prompt: 你是...   # 该 phase agent 的角色设定
    timeout: 900         # 秒
    prompt: |            # agent 阶段：框架自动用 agent 跑这段 prompt
      你是一位...
      \${REQUIREMENT}
\`\`\`

**五种声明式原语**（覆盖几乎所有场景，无需任何代码）：

1. **agent 阶段（prompt）**：要 AI 干活（写作 / 设计 / 写代码 / 评审 / 分析…）就写 \`prompt:\` 字段，
   框架自动用该 phase 的 agent 跑它。这是最常见的阶段。

2. **人工审批（gate）**：要人点头才往下走，写 \`gate: true\`——该 phase 跑完挂起等用户「通过 / 驳回」。

3. **自动判据回路（reject + decision）**：要「评审 agent 自己判通过 / 驳回，驳回则回上游重做」，在评审
   phase 上写：
   \`\`\`yaml
   - name: review
     prompt: |
       审查上游产物，依据下面判据自行裁决（通过 / 驳回，驳回须说明问题）。
     reject: design          # 驳回回退到哪个早期 phase（只能往回跳）
     max_rejections: 3       # 触顶自动停下报人
     decision:
       mode: tool            # 评审 agent 自己调 submit_decision 出裁决（pass/reject）
       criteria: |           # 判据：怎样算通过 / 驳回
         架构方向正确、核心需求有覆盖即 pass；仅架构性硬伤才 reject。
   \`\`\`

4. **交付 PR（deliver: pr）**：要把代码改动 commit/push 并开 GitHub PR，写一个交付 phase：
   \`\`\`yaml
   - name: submit_pr
     label: 提交 PR
     deliver: pr             # 框架内置 PR 交付器（逐库 commit/push + 开 PR），零代码
     pr_body_from: design    # 可选：取某阶段 agent 产物作 PR body 方案摘要
   \`\`\`

5. **交付文件产物（deliver: artifacts）**：要产出文件类交付物（文档 / 设计图 / 网页 demo）让用户验收，
   agent 阶段把产物写到 \${DELIVERABLES} 目录，再加一个 \`deliver: artifacts\` phase 收口验收。

并行：用 \`parallel:\` 块让多个子阶段并行（如前端 / 后端同时开发）。

变量占位符（写在 prompt 里）：
- \${TASK_TITLE} 任务标题 / \${REQUIREMENT} 需求详情 / \${WORKSPACE} 工作目录 / \${PHASE} 当前 phase 名
- \${DELIVERABLES} 文件交付目录（配合 deliver: artifacts）
- \${HANDOFF_<phase>} 取某上游 agent 阶段的产物（需该 phase 写 \`handoff: true\`）

**铁律**：
- **绝不写代码 / ts / run_ 函数**。任何「要判断分支 / 要交付 / 要审批」的需求，都用上面的声明式原语表达
  （判断→decision、交付→deliver、审批→gate）。框架不接受用户代码。
- 每个 phase 必须能跑：要么有 \`prompt\`，要么 \`gate: true\`，要么 \`deliver: pr|artifacts\`。
- name 是 snake_case 英文；label 是中文显示名（用户用什么语言就用什么）；顶层 + 每个 phase 都尽量填 label。

读用户描述（可能含 prior_yaml 表示在原基础上增量调整）。

**输出格式为 YAML**（不是 JSON），结构如下：

\`\`\`yaml
name: backend_dev                       # snake_case 短名
description: 一句话用例说明
yaml: |
  # 这里写完整 workflow.yaml 内容（纯声明，无 ts）
  name: backend_dev
  label: 后端开发
  phases:
    - name: design
      label: 设计
      prompt: |
        ...                              # prompt 可含任意引号 / 多行，不需转义
\`\`\`

⭐ 用 **YAML** 而不是 JSON：yaml 的 \`|\` 块内 prompt 可原样含双引号 / 中文 / 多行 / 反斜杠，**不需转义**。

直接输出 YAML 文本，不要解释、不要 \`\`\`yaml 围栏、**不要 ts 字段**。`;

export interface AuthorInput {
  description: string;
  prior_yaml?: string;
}

export interface AuthorResult {
  name: string;
  description: string;
  yaml: string;
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
  if (input.prior_yaml) {
    p += "\n\n上一版 yaml：\n```yaml\n" + input.prior_yaml + "\n```";
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
    timeout: 900
    prompt: |
      ${description}
`;
  return { name, description, yaml, warnings: [`AI 生成失败：${reason}`] };
}

export async function runWorkflowAuthor(input: AuthorInput): Promise<AuthorResult> {
  let raw: string;
  try {
    raw = await _authorFn(buildPrompt(input));
  } catch (e: unknown) {
    log.warn("AI 调用失败：%s", e instanceof Error ? e.message : String(e));
    return fallback(input, e instanceof Error ? e.message : String(e));
  }

  let parsed: { name?: unknown; description?: unknown; yaml?: unknown };
  try {
    parsed = parseLlmYamlWrapper(raw);
  } catch (e: unknown) {
    log.warn("AI 顶层 YAML 解析失败：%s", e instanceof Error ? e.message : String(e));
    return fallback(input, "AI 返回非法格式");
  }

  if (typeof parsed.yaml !== "string" || !parsed.yaml.trim()) {
    return fallback(input, "缺 yaml 字段");
  }

  // yaml 合法性
  const warnings: string[] = [];
  let parsedYaml: Record<string, unknown> | null = null;
  try {
    parsedYaml = parseYaml(parsed.yaml) as Record<string, unknown>;
  } catch (e: unknown) {
    warnings.push(`yaml 解析失败：${e instanceof Error ? e.message : String(e)}`);
  }

  // 声明式工作流：每个 phase 必须有框架原语能跑——prompt（agent）/ gate（人工审批）/ deliver（交付）。
  // 没有任一 = 声明式下跑不起来（不再有 ts 兜底）。
  const runnable = (p: Record<string, unknown>): boolean =>
    (typeof p.prompt === "string" && p.prompt.trim() !== "") ||
    p.gate === true ||
    (typeof p.deliver === "string" && p.deliver.trim() !== "");
  if (parsedYaml && Array.isArray(parsedYaml.phases)) {
    for (const p of parsedYaml.phases as Array<Record<string, unknown>>) {
      if (!p || typeof p !== "object") continue;
      if (p.parallel && typeof p.parallel === "object") {
        const par = p.parallel as Record<string, unknown>;
        const subs = Array.isArray(par.phases) ? (par.phases as Array<Record<string, unknown>>) : [];
        for (const s of subs) {
          if (typeof s.name === "string" && !runnable(s)) {
            warnings.push(`阶段 ${s.name} 没有可执行声明（prompt / gate / deliver），会跑不起来`);
          }
        }
      } else if (typeof p.name === "string" && !runnable(p)) {
        warnings.push(`阶段 ${p.name} 没有可执行声明（prompt / gate / deliver），会跑不起来`);
      }
      // 误生成 ts / run_ 函数引用的提示（声明式不接受代码）
      if (typeof (p as Record<string, unknown>).func === "string") {
        warnings.push(`阶段 ${String(p.name)} 声明了 func（代码引用）——声明式工作流不支持，请改用 prompt / gate / deliver`);
      }
    }
  }

  const name = typeof parsed.name === "string" && WORKFLOW_NAME_RE.test(parsed.name)
    ? parsed.name
    : "new_workflow";
  const description = typeof parsed.description === "string"
    ? parsed.description
    : input.description.slice(0, 60);

  return {
    name,
    description,
    yaml: parsed.yaml,
    warnings,
  };
}

/**
 * 把 AI 生成的声明式 yaml 落成 **native DB 工作流**（不写磁盘）——与 json-only / DB 真相源方向一致。
 * yaml 是 AI 的人类友好生成面，这里转 spec_json 经 createNativeDbWorkflow 落库（内部 normalizeSpecDoc
 * 校验 phases / 归一 name / strip 函数字段）。名字非法 / 已存在 / 结构非法 → 抛错。
 */
export function saveAuthoredWorkflow(name: string, yaml: string): void {
  if (!WORKFLOW_NAME_RE.test(name)) {
    throw new Error("name 只允许小写字母开头 + 小写字母/数字/_/-（≤40 字符）");
  }
  const doc = parseWorkflowText(yaml, "yaml");
  if (!doc || typeof doc !== "object" || !Array.isArray((doc as Record<string, unknown>).phases)) {
    throw new Error("yaml 缺 phases 字段");
  }
  const description = typeof (doc as Record<string, unknown>).description === "string"
    ? (doc as Record<string, unknown>).description as string
    : "";
  createNativeDbWorkflow({ name, description, spec_json: stringifyWorkflowDoc(doc, "json") });
}
