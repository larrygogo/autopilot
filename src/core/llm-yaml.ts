/**
 * LLM 顶层 wrapper YAML 解析。
 *
 * 选 YAML 而不是 JSON 的理由：
 *   - 真实 LLM 输出经常在字符串字段（如 prompt / spec_md）里嵌套未转义双引号，
 *     这是字面意义的歧义问题，jsonrepair 等修复库也无法可靠处理；
 *   - YAML 的 `|` 多行块原生支持任意引号 / 中文 / 换行 / 反斜杠，
 *     完全不需要转义，从根上绕开 JSON 转义地狱；
 *   - YAML 是 JSON 超集，老的 LLM 输出 JSON 也能用 YAML parser 兼容解析，
 *     旧 prompt / 测试 fixture 无需迁移。
 *
 * 这里只负责"剥 markdown 围栏 + 解析顶层为对象"，业务字段校验由调用方做。
 */

import { parse as parseYaml } from "yaml";

/**
 * 解析 LLM 顶层 YAML wrapper。
 *
 * - 先剥 ```yaml/```yml/``` 围栏（LLM 经常忽略 "不要围栏" 指令）；
 * - 然后调 yaml parse；
 * - 顶层必须是 object，否则抛（防 LLM 输出纯字符串走不下去）。
 *
 * 失败时抛 Error，让调用方走 fallback。
 */
export function parseLlmYamlWrapper(raw: string): Record<string, unknown> {
  let s = raw.trim();
  const fence = s.match(/```(?:yaml|yml|YAML|json|JSON)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1]!.trim();
  if (!s) throw new Error("LLM 输出为空");
  const result = parseYaml(s);
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("YAML 顶层不是对象");
  }
  return result as Record<string, unknown>;
}
