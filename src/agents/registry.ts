import { Agent } from "./agent";
import type { AgentConfig } from "./types";
import type { BaseProvider } from "./providers/base";
import { AnthropicProvider } from "./providers/anthropic";
import { OpenAIProvider } from "./providers/openai";
import { GoogleProvider } from "./providers/google";
import { getWorkflow } from "../core/registry";

const PROVIDERS: Record<string, new (config: Record<string, unknown>) => BaseProvider> = {
  anthropic: AnthropicProvider,
  openai: OpenAIProvider,
  google: GoogleProvider,
};

const _cache = new Map<string, Agent>();

/**
 * 根据配置创建 Agent 实例（不缓存）
 */
export function createAgent(config: AgentConfig): Agent {
  const ProviderClass = PROVIDERS[config.provider];
  if (!ProviderClass) {
    throw new Error(`未知 provider：${config.provider}，支持：${Object.keys(PROVIDERS).join("、")}`);
  }
  const provider = new ProviderClass(config as unknown as Record<string, unknown>);
  return new Agent(config.name, provider, config);
}

/**
 * 获取（或创建并缓存）Agent 实例。
 * 缓存 key 为 `workflowName:agentName`，同一工作流内复用同一 Agent。
 */
export function getAgent(agentName: string, workflowName: string): Agent {
  const cacheKey = `${workflowName}:${agentName}`;
  if (_cache.has(cacheKey)) {
    return _cache.get(cacheKey)!;
  }

  const wf = getWorkflow(workflowName);
  if (!wf) {
    throw new Error(`工作流不存在：${workflowName}`);
  }

  const agentConfigs = wf.agents as AgentConfig[] | undefined;
  if (!agentConfigs || agentConfigs.length === 0) {
    throw new Error(`工作流 ${workflowName} 未定义任何 agent`);
  }

  const agentConfig = agentConfigs.find((a) => a.name === agentName);
  if (!agentConfig) {
    throw new Error(`工作流 ${workflowName} 中找不到 agent：${agentName}`);
  }

  const agent = createAgent(agentConfig);
  _cache.set(cacheKey, agent);
  return agent;
}

/**
 * 关闭并清除指定工作流的所有缓存 Agent
 */
export async function closeAgents(workflowName: string): Promise<void> {
  const prefix = `${workflowName}:`;
  const closePromises: Promise<void>[] = [];

  for (const [key, agent] of _cache.entries()) {
    if (key.startsWith(prefix)) {
      closePromises.push(agent.close());
      _cache.delete(key);
    }
  }

  await Promise.all(closePromises);
}

/**
 * 仅用于测试：清空全部缓存
 */
export function _resetForTest(): void {
  _cache.clear();
}
