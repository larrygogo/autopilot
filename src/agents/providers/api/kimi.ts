/**
 * Kimi Code（api.kimi.com/coding）端点 quirks 收口（architect 审查：原散在 compat.ts + openai.ts
 * 各自 sniff host）。这个 OpenAI 兼容端点对编码 Agent 有两条特殊要求，集中在此一处：
 *   1. UA 闸门：非编码-agent UA 返回 403 → 注入被认可的 coding-agent UA
 *   2. 思考端点拒绝强制 tool_choice（400 incompatible with thinking）→ 调用方据此把
 *      disable_thinking 翻译成 thinking:{type:disabled}（见 openai.ts）
 */

/** 是否 kimi.com 端点（含子域）。URL 非法时保守返回 false。 */
export function isKimiHost(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.endsWith("kimi.com");
  } catch {
    return false;
  }
}

// kimi 按 UA 限定只给编码 Agent；此版本号会过期（kimi 收紧白名单时 403）——
// 可用 KIMI_CODING_UA 环境变量覆盖而无需改代码。
const DEFAULT_KIMI_CODING_UA = "claude-cli/2.1.176 (external, cli)";

/** kimi.com host 返回认可的 coding-agent UA（env KIMI_CODING_UA 可覆盖）；非 kimi 返回 undefined。 */
export function kimiCodingAgentUa(baseUrl: string): string | undefined {
  if (!isKimiHost(baseUrl)) return undefined;
  return process.env.KIMI_CODING_UA?.trim() || DEFAULT_KIMI_CODING_UA;
}
