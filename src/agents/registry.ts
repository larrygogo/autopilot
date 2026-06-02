import { Agent } from "./agent";
import type { AgentConfig, ProviderName } from "./types";
import type { BaseProvider } from "./providers/base";
import { AnthropicProvider } from "./providers/anthropic";
import { OpenAIProvider } from "./providers/openai";
import { GoogleProvider } from "./providers/google";
import { getWorkflow, getPhase } from "../core/registry";
import { loadGlobalAgents, loadProviders, loadConversationConfig, loadAgentAliases, type ProviderConfig } from "../core/config";
import { AGENT_DEFAULTS, DEFAULT_AGENT, type InlineAgentConfig } from "../core/agent-defaults";

/**
 * 解析 agent 别名（spec §3.11.1）。
 *
 * 规则：
 *   - alias 不在表里 → 返回原名
 *   - 命中 → 返回 target；若 target 又是 alias key，**抛错拒绝链式**（只允许一跳）
 *   - 调用方应在 workflow.agents[] 同名查询失败后才走 alias，让 workflow 覆盖优先
 */
export function resolveAliasTarget(
  agentName: string,
  aliases: Record<string, string> = loadAgentAliases(),
): string {
  if (!(agentName in aliases)) return agentName;
  const target = aliases[agentName];
  if (target in aliases) {
    throw new Error(
      `agent alias 链式跳转禁止：${agentName} → ${target} → ${aliases[target]}。` +
      `请在 config.yaml agent_aliases 改为直接指向最终 target（只允许一跳）`,
    );
  }
  return target;
}

/**
 * 加载"生效"的全局 agents：内置默认 + 用户 yaml override。
 *
 * 用户在 config.yaml.agents.<name> 写的字段覆盖内置同名 agent 的对应字段
 * （partial override，只覆盖写了的字段）。完全没写时使用内置默认。
 *
 * 解决新用户痛点：不写 yaml 也能跑——coder / reviewer / clarifier 都有合理默认。
 */
export function loadEffectiveGlobalAgents(): Record<string, Record<string, unknown>> {
  const userAgents = loadGlobalAgents();
  const result: Record<string, Record<string, unknown>> = {};
  // 先放内置默认
  for (const [name, def] of Object.entries(AGENT_DEFAULTS)) {
    result[name] = { ...def };
  }
  // 用户字段 override（partial：保留内置中未被覆盖的字段）
  for (const [name, cfg] of Object.entries(userAgents)) {
    result[name] = { ...(result[name] ?? {}), ...cfg };
  }
  return result;
}

const PROVIDERS: Record<string, new (config: Record<string, unknown>) => BaseProvider> = {
  anthropic: AnthropicProvider,
  openai: OpenAIProvider,
  google: GoogleProvider,
};

const _cache = new Map<string, Agent>();

/**
 * 将全局 agent 基底与工作流覆盖做浅合并（后者优先）。
 * 返回完整 AgentConfig；若缺 provider 或字段不合法则抛错。
 *
 * Phase 7（spec §3.11.1）：若 baseKey 不在 globalAgents 中，且 workflowAgent 也没提供
 * provider，则查 agent_aliases —— alias 命中 target 时用 target 的 base，但 merged.name
 * 保留原 agentName（UI/日志显示用户视角的 role）。
 */
export function resolveAgentConfig(
  agentName: string,
  workflowAgent: Partial<AgentConfig> | undefined,
  globalAgents: Record<string, Record<string, unknown>> = loadEffectiveGlobalAgents(),
  providers: Record<string, ProviderConfig> = loadProviders(),
  aliases: Record<string, string> = loadAgentAliases(),
): AgentConfig {
  // 确定继承的全局 key：workflow 显式写 extends 则用它；
  // extends === null/false 则跳过继承；未写则默认继承同名。
  let baseKey: string | null = agentName;
  if (workflowAgent && "extends" in workflowAgent) {
    const ext = workflowAgent.extends;
    if (ext === null || ext === false) baseKey = null;
    else if (typeof ext === "string" && ext.length > 0) baseKey = ext;
  }

  let base: Record<string, unknown> = baseKey ? (globalAgents[baseKey] ?? {}) : {};

  // Phase 7: alias fallback —— workflow 没有覆盖该 agent 且 globalAgents 里没找到 baseKey 时
  // 尝试查 agent_aliases。命中 → 用 alias target 的 base，但 name 保留 agentName
  if (baseKey && Object.keys(base).length === 0 && !workflowAgent) {
    const aliasTarget = resolveAliasTarget(baseKey, aliases);
    if (aliasTarget !== baseKey && globalAgents[aliasTarget]) {
      base = globalAgents[aliasTarget];
    }
  }

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
 * 一次性调用 agent（试跑）—— 不关联任何工作流，不进缓存，跑完立即 close。
 * 用于 UI 里调试 system_prompt / 验证模型可用性。
 *
 * 解析顺序等同 getAgent 但只走 "global agents" 侧；不需要工作流 context。
 * RunOptions 里的 model / max_turns / system_prompt / additional_system 在
 * 此次调用时覆盖，不影响持久配置。
 */
export async function runAgentOnce(
  agentName: string,
  prompt: string,
  options?: Parameters<Agent["run"]>[1],
): Promise<Awaited<ReturnType<Agent["run"]>>> {
  const globalAgents = loadEffectiveGlobalAgents();
  const providers = loadProviders();
  if (!globalAgents[agentName]) {
    throw new Error(`agent "${agentName}" 未在全局 config.yaml 中定义`);
  }
  const resolved = resolveAgentConfig(agentName, undefined, globalAgents, providers);
  const agent = createAgent(resolved);
  try {
    return await agent.run(prompt, options);
  } finally {
    try { await agent.close(); } catch { /* ignore */ }
  }
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

  const globalAgents = loadEffectiveGlobalAgents();
  const providers = loadProviders();
  const aliases = loadAgentAliases();
  const workflowAgents = (wf.agents as Partial<AgentConfig>[] | undefined) ?? [];
  const workflowAgent = workflowAgents.find((a) => a?.name === agentName);

  // Phase 7: workflow 没有覆盖 + 全局也没有同名 → 查 alias
  if (!workflowAgent && !globalAgents[agentName]) {
    const aliasTarget = resolveAliasTarget(agentName, aliases);
    if (aliasTarget === agentName || !globalAgents[aliasTarget]) {
      throw new Error(`找不到 agent "${agentName}"：工作流 ${workflowName} 未定义，全局 config.yaml 中也没有同名条目${aliasTarget !== agentName ? `（agent_aliases 指向 "${aliasTarget}" 也未在全局定义）` : ""}`);
    }
  }

  const resolved = resolveAgentConfig(agentName, workflowAgent, globalAgents, providers, aliases);
  const agent = createAgent(resolved);
  _cache.set(cacheKey, agent);
  return agent;
}

/**
 * 按 phase 解析并构建 Agent（spec：移除命名复用 agent）。
 *
 * 解析规则（取代「按名 getAgent + 三层合并」）：
 *   - phase.agent 是对象 → 内联配置覆盖 DEFAULT_AGENT，model 缺失走 providers.<provider>.default_model
 *   - phase.agent 省略   → 直接用 DEFAULT_AGENT
 *   - phase.agent 是字符串 → 旧格式（命名 agent），兼容期降级走 getAgent（Phase 3 删除）
 *
 * 缓存 key 用 `workflowName:@phase:phaseName`，与 getAgent 的命名 key 区分；
 * closeAgents/clearAllAgentCache 用 `workflowName:` 前缀仍能清理到（防 provider 子进程泄漏）。
 */
export function agentForPhase(workflowName: string, phaseName: string): Agent {
  const phase = getPhase(workflowName, phaseName);
  const spec = phase?.agent;

  // 旧格式：字符串命名 agent → 兼容降级（Phase 3 前保留）
  if (typeof spec === "string") {
    return getAgent(spec, workflowName);
  }

  const cacheKey = `${workflowName}:@phase:${phaseName}`;
  const cached = _cache.get(cacheKey);
  if (cached) return cached;

  const inline: InlineAgentConfig =
    spec && typeof spec === "object" ? (spec as InlineAgentConfig) : {};
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

// ──────────────────────────────────────────────
// 对话（chat）agent 解析
//
// 优先级：
//   1. 显式 agentName（CLI --agent，API body.agent）
//   2. workflow.chat_agent（工作流专属对话 agent）
//   3. conversation.default_agent（全局主对话 agent）
// ──────────────────────────────────────────────

export interface ResolveChatAgentOpts {
  /** 用户显式指定的 agent 名（最高优先级） */
  agent?: string;
  /** 聚焦的工作流名 */
  workflow?: string;
}

export function resolveChatAgentName(opts: ResolveChatAgentOpts = {}): string {
  if (opts.agent) return opts.agent;
  if (opts.workflow) {
    const wf = getWorkflow(opts.workflow);
    const fromWf = wf?.chat_agent;
    if (typeof fromWf === "string" && fromWf.trim()) return fromWf.trim();
  }
  const fromGlobal = loadConversationConfig().default_agent;
  if (fromGlobal) return fromGlobal;
  throw new Error(
    "未指定对话 agent：请传入 --agent，或在工作流的 chat_agent 字段、" +
    "config.yaml 的 conversation.default_agent 中配置"
  );
}

/**
 * 构造一个对话用 Agent 实例（不入缓存，调用方负责 close）。
 * 传入的 agent 名支持：
 *   - 存在于全局 config.yaml 的 agents.<name>
 *   - 若 workflow 提供且该工作流 agents[] 里有同名条目，则合并覆盖
 */
export function createChatAgent(agentName: string, workflowName?: string): Agent {
  const globalAgents = loadEffectiveGlobalAgents();
  const providers = loadProviders();
  let workflowAgent: Partial<AgentConfig> | undefined;
  if (workflowName) {
    const wf = getWorkflow(workflowName);
    const list = (wf?.agents as Partial<AgentConfig>[] | undefined) ?? [];
    workflowAgent = list.find((a) => a?.name === agentName);
  }
  if (!workflowAgent && !globalAgents[agentName]) {
    throw new Error(
      `找不到 agent "${agentName}"：请在 config.yaml 的 agents 段或工作流 agents[] 中定义`
    );
  }
  const resolved = resolveAgentConfig(agentName, workflowAgent, globalAgents, providers);
  return createAgent(resolved);
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
}
