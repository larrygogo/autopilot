import { createLogger } from "../core/logger";
import { parseLlmYamlWrapper } from "../core/llm-yaml";
import { buildClarifierAgent } from "./clarifier-agent";

const log = createLogger("requirement-extract");

const EXTRACT_SYSTEM_PROMPT = `你是需求分析师。
读用户的口语化描述，输出 **YAML** 含两个字段：
- title：≤30 字的标题
- spec_md：Markdown 整理，含 "## 背景" "## 目标" "## 验收" 三段

输出格式：
\`\`\`yaml
title: 用户登录优化
spec_md: |
  ## 背景
  ...                       # 这里可以含任意引号 / 中文 / 多行，不需转义
  ## 目标
  ...
  ## 验收
  ...
\`\`\`

⭐ 用 YAML 而不是 JSON，因为 spec_md 是 markdown 文本经常含 \`"\` 引号，
JSON 转义易错。YAML \`|\` 块完全不需转义。

直接输出 YAML，不要解释、不要 \`\`\`yaml 围栏。`;

export interface ExtractInput {
  raw_text: string;
  project_id: string;
  codebase_id?: string | null;
}

export interface ExtractResult {
  title: string;
  spec_md: string;
}

// 可测试注入：跳过真实 LLM 调用
type ExtractFn = (prompt: string) => Promise<string>;
let _extractFn: ExtractFn = callClaudeForExtract;

export function _setExtractFnForTest(fn: ExtractFn | null): void {
  _extractFn = fn ?? callClaudeForExtract;
}

async function callClaudeForExtract(prompt: string): Promise<string> {
  const agent = buildClarifierAgent();
  const result = await agent.run(prompt, { system_prompt: EXTRACT_SYSTEM_PROMPT });
  return result.text ?? "";
}

/**
 * 一次性抽取 title + spec_md。永不抛——失败时走 raw_text 兜底。
 */
export async function runClarifierExtract(input: ExtractInput): Promise<ExtractResult> {
  const fallback: ExtractResult = {
    title: input.raw_text.slice(0, 30),
    spec_md: input.raw_text,
  };

  let raw: string;
  try {
    raw = await _extractFn(input.raw_text);
  } catch (e: unknown) {
    log.warn("extract LLM 调用失败，走兜底：%s", e instanceof Error ? e.message : String(e));
    return fallback;
  }

  let parsed: { title?: unknown; spec_md?: unknown };
  try {
    parsed = parseLlmYamlWrapper(raw);
  } catch (e: unknown) {
    log.warn("extract LLM 顶层格式非法，走兜底：%s", e instanceof Error ? e.message : String(e));
    return fallback;
  }

  if (typeof parsed.title !== "string" || !parsed.title.trim()) return fallback;
  if (typeof parsed.spec_md !== "string" || !parsed.spec_md.trim()) return fallback;

  return {
    title: parsed.title.trim().slice(0, 30),
    spec_md: parsed.spec_md.trim(),
  };
}
