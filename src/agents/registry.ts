import { Agent } from "./agent";
import type { AgentConfig, ProviderName } from "./types";
import type { BaseProvider } from "./providers/base";
import { AnthropicProvider } from "./providers/anthropic";
import { OpenAIProvider } from "./providers/openai";
import { GoogleProvider } from "./providers/google";
import { getPhase } from "../core/registry";
import { loadProviders } from "../core/config";
import { DEFAULT_AGENT, type InlineAgentConfig } from "../core/agent-defaults";
import { log } from "../core/logger";

const PROVIDERS: Record<string, new (config: Record<string, unknown>) => BaseProvider> = {
  anthropic: AnthropicProvider,
  openai: OpenAIProvider,
  google: GoogleProvider,
};

const _cache = new Map<string, Agent>();

/** 记录已警告过的废弃 string agent，避免每次解析都刷屏 */
const _warnedLegacyString = new Set<string>();

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
 * 按 phase 解析并构建 Agent（spec：已移除命名复用 agent）。
 *
 * 解析规则：
 *   - phase.agent 是对象 → 内联配置覆盖 DEFAULT_AGENT，model 缺失走 providers.<provider>.default_model
 *   - phase.agent 省略   → 直接用 DEFAULT_AGENT
 *   - phase.agent 是字符串 → 已废弃的命名 agent 引用：warn 一次后按 DEFAULT_AGENT 兜底跑
 *
 * 缓存 key 用 `workflowName:@phase:phaseName`；
 * closeAgents/clearAllAgentCache 用 `workflowName:` 前缀仍能清理到（防 provider 子进程泄漏）。
 */
export function agentForPhase(workflowName: string, phaseName: string): Agent {
  const phase = getPhase(workflowName, phaseName);
  const spec = phase?.agent;

  const cacheKey = `${workflowName}:@phase:${phaseName}`;
  const cached = _cache.get(cacheKey);
  if (cached) return cached;

  // 废弃格式：字符串命名 agent → warn 一次 + 回退 DEFAULT_AGENT
  let inline: InlineAgentConfig = {};
  if (typeof spec === "string") {
    const warnKey = `${workflowName}:${phaseName}:${spec}`;
    if (!_warnedLegacyString.has(warnKey)) {
      _warnedLegacyString.add(warnKey);
      log.warn(
        "工作流 %s 的 phase %s 使用了已废弃的命名 agent 引用 \"%s\"；命名复用 agent 机制已移除，将按 DEFAULT_AGENT 兜底运行。请改用内联 agent 配置对象。",
        workflowName, phaseName, spec,
      );
    }
  } else if (spec && typeof spec === "object") {
    inline = spec as InlineAgentConfig;
  }

  const merged: Record<string, unknown> = { ...DEFAULT_AGENT, ...inline };

  const provider = (merged["provider"] as string | undefined) ?? DEFAULT_AGENT.provider;
  merged["provider"] = provider;

  // provider 层 fallback：没写 model 时用 providers.<provider>.default_model
  if (!merged["model"]) {
    const providerCfg = loadProviders()[provider as ProviderName];
    if (providerCfg?.default_model) merged["model"] = providerCfg.default_model;
  }

  // 匿名 agent：用 phase 名做标识（日志 / header / 缓存）
  merged["name"] = phaseName;

  const agent = createAgent(merged as AgentConfig);
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
 * 清空所有 Agent 缓存 + close 它们各自的资源（dogfood-bug27）。
 *
 * 客户在 web Settings 改 agent model / system_prompt 后，daemon 必须丢弃
 * 旧 cache 实例，否则下个 task 仍用老配置。daemon 启动时订阅
 * `config:updated` 事件回调此函数即可。
 */
export async function clearAllAgentCache(): Promise<void> {
  const closePromises: Promise<void>[] = [];
  for (const agent of _cache.values()) {
    closePromises.push(agent.close().catch(() => { /* close 失败不影响清缓存 */ }));
  }
  _cache.clear();
  await Promise.all(closePromises);
}

/**
 * 仅用于测试：清空全部缓存（同步，不等 close）
 */
export function _resetForTest(): void {
  _cache.clear();
  _warnedLegacyString.clear();
}
