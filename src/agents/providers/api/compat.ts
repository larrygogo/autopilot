/**
 * OpenAI 兼容层适配器（DeepSeek / Kimi / MiniMax 等）。
 *
 * 继承 OpenAI 适配器，仅覆盖 base_url。
 * 预置三家供应商的端点和默认模型，MiMo 暂不预置（官方 API 端点待确认）。
 */

import { OpenAIApiAdapter } from "./openai";
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

/** 三大官方 provider 名称（支持 CLI 模式） */
const CLI_PROVIDERS = new Set(["anthropic", "openai", "google"]);

/** 判断是否为仅 API 模式的供应商（无 CLI） */
export function isCompatOnlyProvider(name: string): boolean {
  return !CLI_PROVIDERS.has(name);
}

/** 获取供应商的预置信息（如果有） */
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
  const adapter = new OpenAIApiAdapter(apiKey, baseUrl);
  // 用闭包包一层，让 name 能正确反映 compat provider
  return {
    get name() { return providerName || "compat"; },
    completeStream: adapter.completeStream.bind(adapter),
  };
}
