import { createLogger } from "../core/logger";
import { buildClarifierAgent } from "./clarifier-agent";

const log = createLogger("requirement-extract");

const EXTRACT_SYSTEM_PROMPT = `你是需求分析师。
读用户的口语化描述，输出**严格 JSON** 含两个字段：
- title：≤30 字的标题
- spec_md：Markdown 整理，含 "## 背景" "## 目标" "## 验收" 三段

只输出 JSON，不要解释、不要 \`\`\`json 围栏。`;

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
    parsed = JSON.parse(raw);
  } catch {
    log.warn("extract LLM 返回非法 JSON，走兜底");
    return fallback;
  }

  if (typeof parsed.title !== "string" || !parsed.title.trim()) return fallback;
  if (typeof parsed.spec_md !== "string" || !parsed.spec_md.trim()) return fallback;

  return {
    title: parsed.title.trim().slice(0, 30),
    spec_md: parsed.spec_md.trim(),
  };
}
