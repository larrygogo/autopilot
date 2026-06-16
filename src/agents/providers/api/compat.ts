/**
 * OpenAI 兼容层适配器（DeepSeek / Kimi / MiniMax 等）。
 *
 * 继承 OpenAI 适配器，仅覆盖 base_url。
 * 预置三家供应商的端点和默认模型，MiMo 暂不预置（官方 API 端点待确认）。
 */

import { OpenAIApiAdapter } from "./openai";
import { kimiCodingAgentUa } from "./kimi";
import type { ProviderAdapter } from "./types";

// ── 预置供应商 ──

export interface CompatProviderPreset {
  base_url: string;
  env_key: string;
  default_model: string;
  display_name: string;
}

export const BUILTIN_COMPAT_PROVIDERS: Record<string, CompatProviderPreset> = {
  deepseek: {
    base_url: "https://api.deepseek.com",
    env_key: "DEEPSEEK_API_KEY",
    default_model: "deepseek-chat",
    display_name: "DeepSeek",
  },
  kimi: {
    base_url: "https://api.moonshot.cn",
    env_key: "KIMI_API_KEY",
    default_model: "moonshot-v1-8k",
    display_name: "Kimi (Moonshot)",
  },
  // Kimi Code（K2.7 Code）：OpenAI 兼容，端点 https://api.kimi.com/coding（适配器补 /v1/chat/completions）。
  // ⚠ 该端点按 User-Agent 限定只给编码 Agent（claude-cli / RooCode 等）—— createCompatAdapter
  //    对 kimi.com host 注入被认可的 coding-agent UA，否则 403。模型 id 实测 = kimi-for-coding。
  "kimi-code": {
    base_url: "https://api.kimi.com/coding",
    env_key: "KIMI_CODE_API_KEY",
    default_model: "kimi-for-coding",
    display_name: "Kimi Code (K2.7)",
  },
  minimax: {
    base_url: "https://api.minimax.chat",
    env_key: "MINIMAX_API_KEY",
    default_model: "abab6.5s-chat",
    display_name: "MiniMax",
  },
  // MiMo: 待官方确认 API 端点后再加入预置列表。
  // 用户可通过自定义 compat provider 配置：
  //   providers:
  //     mimo:
  //       base_url: https://api.mimo.ai/v1
  //       env_key_name: MIMO_API_KEY
};

/** 获取供应商的预置信息（如果有）。provider 条目化后 BUILTIN_COMPAT_PROVIDERS 转「模板目录」用。 */
export function getCompatPreset(name: string): CompatProviderPreset | undefined {
  return BUILTIN_COMPAT_PROVIDERS[name];
}

/**
 * 创建兼容层适配器。
 *
 * @param apiKey API 密钥
 * @param baseUrl 自定义 base_url（覆盖预置端点）
 * @param providerName 供应商名称（用于日志标识）
 */
export function createCompatAdapter(
  apiKey: string,
  baseUrl: string,
  providerName?: string,
): ProviderAdapter {
  // 编码专用端点（如 Kimi Code）的 UA 闸门收口在 kimi.ts（非编码 UA 返回 403）
  const adapter = new OpenAIApiAdapter(apiKey, baseUrl, kimiCodingAgentUa(baseUrl));
  // 用闭包包一层，让 name 能正确反映 compat provider
  return {
    get name() { return providerName || "compat"; },
    completeStream: adapter.completeStream.bind(adapter),
  };
}
