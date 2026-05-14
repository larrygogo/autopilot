import { resolveAgentConfig, createAgent } from "../agents/registry";
import { loadGlobalAgents, loadProviders } from "../core/config";
import type { Agent } from "../agents/agent";

export interface ClarifierAgentOverride {
  provider?: "anthropic" | "openai" | "google";
  model?: string;
}

/**
 * 解析并实例化 clarifier agent。
 * - 复用 config.yaml.agents.clarifier 配置（不存在时用 anthropic 默认）
 * - 调用方可传 override（req 级覆盖时用）
 * 返回值可被 clarifier 调查阶段、extract 抽取阶段共用。
 */
export function buildClarifierAgent(override: ClarifierAgentOverride = {}): Agent {
  const globalAgents = loadGlobalAgents();
  const providers = loadProviders();
  const globalClarifier = globalAgents["clarifier"] ?? { provider: "anthropic" };
  const merged = { ...globalClarifier, ...override };
  const resolved = resolveAgentConfig("clarifier", undefined, { clarifier: merged }, providers);
  return createAgent(resolved);
}
