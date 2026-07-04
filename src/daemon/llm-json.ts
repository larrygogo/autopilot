/**
 * LLM JSON 输出降级解析 helper。
 *
 * P3 后 LLM 结构化输出主路径 = 工具提交（submit_clarify / submit_workflow）；
 * 降级契约 = 正文输出 ```json 围栏块。此模块只负责剥围栏，JSON.parse 由调用方做
 * （各方错误语义/兜底策略不同）。
 */

/** 从 LLM 输出提取 ```json ... ``` 块内容（无围栏则返回 null，调用方自行降级）。 */
export function extractJsonBlock(text: string): string | null {
  const m = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  return m ? m[1].trim() : null;
}
