import { Agent } from "./agent";
import type { AgentConfig, ProviderName } from "./types";
import type { BaseProvider } from "./providers/base";
import { AnthropicProvider } from "./providers/anthropic";
import { OpenAIProvider } from "./providers/openai";
import { GoogleProvider } from "./providers/google";
import { getWorkflow } from "../core/registry";
import { loadGlobalAgents, loadProviders, type ProviderConfig } from "../core/config";

const PROVIDERS: Record<string, new (config: Record<string, unknown>) => BaseProvider> = {
  anthropic: AnthropicProvider,
  openai: OpenAIProvider,
  google: GoogleProvider,
};

const _cache = new Map<string, Agent>();

/**
 * 将全局 agent 基底与工作流覆盖做浅合并（后者优先）。
 * 返回完整 AgentConfig；若缺 provider 或字段不合法则抛错。
 */
export function resolveAgentConfig(
  agentName: string,
  workflowAgent: Partial<AgentConfig> | undefined,
  globalAgents: Record<string, Record<string, unknown>> = loadGlobalAgents(),
  providers: Record<string, ProviderConfig> = loadProviders(),
): AgentConfig {
  // 确定继承的全局 key：workflow 显式写 extends 则用它；
  // extends === null/false 则跳过继承；未写则默认继承同名。
  let baseKey: string | null = agentName;
  if (workflowAgent && "extends" in workflowAgent) {
    const ext = workflowAgent.extends;
    if (ext === null || ext === false) baseKey = null;
    else if (typeof ext === "string" && ext.length > 0) baseKey = ext;
  }
  const base = baseKey ? (globalAgents[baseKey] ?? {}) : {};

  // 浅合并：base < workflow override
  const merged: Record<string, unknown> = { ...base, ...(workflowAgent ?? {}) };
  merged["name"] = agentName;
  delete merged["extends"];

  const provider = merged["provider"] as string | undefined;
  if (!provider) {
    throw new Error(`agent "${agentName}" 缺少 provider 字段（可在全局 config.yaml 的 agents.${agentName} 中定义，或在工作流 agents[] 中显式提供）`);
  }
  if (!(provider in PROVIDERS)) {
    throw new Error(`未知 provider：${provider}，支持：${Object.keys(PROVIDERS).join("、")}`);
  }

  // provider 层 fallback：agent 没写 model 时使用 providers.<provider>.default_model
  const providerCfg = providers[provider];
  if (providerCfg) {
    if (!merged["model"] && providerCfg.default_model) merged["model"] = providerCfg.default_model;
    if (!merged["base_url"] && providerCfg.base_url) merged["base_url"] = providerCfg.base_url;
    if (!merged["api_key_env"] && providerCfg.api_key_env) merged["api_key_env"] = providerCfg.api_key_env;
  }

  return merged as AgentConfig;
}

/**
 * 根据配置创建 Agent 实例（不缓存）。
 * 传入的 config 必须已合并完成（包含 provider 等字段）。
 */
export function createAgent(config: AgentConfig): Agent {
  const ProviderClass = PROVIDERS[config.provider as ProviderName];
  if (!ProviderClass) {
    throw new Error(`未知 provider：${config.provider}，支持：${Object.keys(PROVIDERS).join("、")}`);
  }
  const provider = new ProviderClass(config as unknown as Record<string, unknown>);
  return new Agent(config.name, provider, config);
}

/**
 * 获取（或创建并缓存）Agent 实例。
 * 缓存 key 为 `workflowName:agentName`，同一工作流内复用同一 Agent。
 *
 * 解析顺序：
 *   1. 全局 config.yaml 的 `agents.<agentName>`（如 extends 指定了别名，则用该别名）
 *   2. 工作流 `agents[]` 中 name 匹配的条目覆盖
 *   3. 若两处都未定义，抛错
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

  const globalAgents = loadGlobalAgents();
  const providers = loadProviders();
  const workflowAgents = (wf.agents as Partial<AgentConfig>[] | undefined) ?? [];
  const workflowAgent = workflowAgents.find((a) => a?.name === agentName);

  if (!workflowAgent && !globalAgents[agentName]) {
    throw new Error(`找不到 agent "${agentName}"：工作流 ${workflowName} 未定义，全局 config.yaml 中也没有同名条目`);
  }

  const resolved = resolveAgentConfig(agentName, workflowAgent, globalAgents, providers);
  const agent = createAgent(resolved);
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
