import { createLogger } from "../core/logger";
import { extractJsonBlock } from "./llm-json";
import { buildClarifierAgent } from "./clarifier-agent";

const log = createLogger("requirement-extract");

const EXTRACT_SYSTEM_PROMPT = `你是需求分析师。
读用户的口语化描述，输出一个 \`\`\`json 围栏块，含两个字段：
- title：≤30 字的标题
- spec_md：Markdown 整理，含 "## 背景" "## 目标" "## 验收" 三段

输出格式：
\`\`\`json
{
  "title": "用户登录优化",
  "spec_md": "## 背景\\n...\\n## 目标\\n...\\n## 验收\\n..."
}
\`\`\`

注意 spec_md 是 JSON 字符串：换行写 \\n，内嵌双引号写 \\"。
只输出这一个 JSON 块，不要任何额外解释文字。`;

export interface ExtractInput {
  raw_text: string;
  project_id: string;
  workspace_id?: string | null;
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

  // 解析优先级：```json 围栏块 → 整段裸 JSON。都失败走兜底（永不抛语义保持）。
  let parsed: { title?: unknown; spec_md?: unknown } | null = null;
  const jsonBlock = extractJsonBlock(raw);
  if (jsonBlock) {
    try { parsed = JSON.parse(jsonBlock) as { title?: unknown; spec_md?: unknown }; } catch { /* 落到裸 JSON 再试 */ }
  }
  if (!parsed) {
    try { parsed = JSON.parse(raw.trim()) as { title?: unknown; spec_md?: unknown }; } catch { /* 走兜底 */ }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    log.warn("extract LLM 输出非 JSON 对象，走兜底");
    return fallback;
  }

  if (typeof parsed.title !== "string" || !parsed.title.trim()) return fallback;
  if (typeof parsed.spec_md !== "string" || !parsed.spec_md.trim()) return fallback;

  return {
    title: parsed.title.trim().slice(0, 30),
    spec_md: parsed.spec_md.trim(),
  };
}
