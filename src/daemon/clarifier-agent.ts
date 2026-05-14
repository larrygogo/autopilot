import { resolveAgentConfig, createAgent, loadEffectiveGlobalAgents } from "../agents/registry";
import { loadProviders } from "../core/config";
import type { Agent } from "../agents/agent";

export interface ClarifierAgentOverride {
  provider?: "anthropic" | "openai" | "google";
  model?: string;
}

/**
 * 解析并实例化 clarifier agent。
 * - 优先从 effective global agents 取 clarifier（含内置默认 + 用户 yaml override）
 * - 调用方可传 override（req 级覆盖时用）
 * 返回值可被 clarifier 调查阶段、extract 抽取阶段共用。
 */
export function buildClarifierAgent(override: ClarifierAgentOverride = {}): Agent {
  const globalAgents = loadEffectiveGlobalAgents();
  const providers = loadProviders();
  const globalClarifier = globalAgents["clarifier"] ?? { provider: "anthropic" };
  const merged = { ...globalClarifier, ...override };
  const resolved = resolveAgentConfig("clarifier", undefined, { clarifier: merged }, providers);
  return createAgent(resolved);
}
