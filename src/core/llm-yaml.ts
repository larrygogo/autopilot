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

const FENCE_HEADER = /^```(?:yaml|yml|YAML|json|JSON)?[ \t]*\n?/;

/**
 * 整段以 ``` 开头时剥最外层围栏；其余情况原样返回。
 *
 * 关键约束：闭合围栏只认**结尾处**的 ```（而不是内容里出现的第一个 ```）。
 * spec_md 等字段值经常内嵌 ``` 代码块，按"第一个 ``` 闭合"截断会把 YAML
 * 拦腰切掉后续字段（dogfood 实锤：clarifier 持续 missing/invalid done）。
 * 缺闭合围栏（输出被截断）时也尽量解析剩余内容。
 */
function stripOuterFence(s: string): string {
  if (!s.startsWith("```")) return s;
  let inner = s.replace(FENCE_HEADER, "");
  inner = inner.replace(/\n?```\s*$/, "");
  return inner.trim();
}

/**
 * 兜底：模型不听"只输出 YAML"，在围栏块前后夹了说明文字。
 * 从第一个独立围栏头行之后提取，闭合取**最后一个**行首 ```（保内嵌代码块完整）。
 */
function extractFencedBlock(s: string): string | null {
  const header = s.match(/(?:^|\n)```(?:yaml|yml|YAML|json|JSON)?[ \t]*\n/);
  if (!header || header.index === undefined) return null;
  const start = header.index + header[0].length;
  const lastClose = s.lastIndexOf("\n```");
  const inner = lastClose > start ? s.slice(start, lastClose) : s.slice(start);
  return inner.trim() || null;
}

function parseAsObject(s: string): Record<string, unknown> | null {
  let result: unknown;
  try {
    result = parseYaml(s);
  } catch {
    return null;
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  return result as Record<string, unknown>;
}

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
  const trimmed = raw.trim();
  const s = stripOuterFence(trimmed);
  if (!s) throw new Error("LLM 输出为空");

  const direct = parseAsObject(s);
  if (direct) return direct;

  // 直接解析失败 → 试"前导文字 + 围栏块"兜底路径
  const fenced = extractFencedBlock(trimmed);
  if (fenced) {
    const fromFence = parseAsObject(fenced);
    if (fromFence) return fromFence;
  }

  // 复现原始报错语义：能 parse 但顶层不是对象 → "不是对象"；parse 不动 → 抛 parse 错误
  const result = parseYaml(s);
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("YAML 顶层不是对象");
  }
  // 理论不可达（parseAsObject 已覆盖），保险兜底
  return result as Record<string, unknown>;
}
