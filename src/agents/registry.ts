import { Agent } from "./agent";
import type { AgentConfig, ProviderName, AgentMode } from "./types";
import type { BaseProvider } from "./providers/base";
import { AnthropicProvider } from "./providers/anthropic";
import { OpenAIProvider } from "./providers/openai";
import { GoogleProvider } from "./providers/google";
import { getPhase } from "../core/registry";
import { loadProviders, type ProviderConfig } from "../core/config";
import { DEFAULT_AGENT, type InlineAgentConfig } from "../core/agent-defaults";
import { log } from "../core/logger";
import { isCompatOnlyProvider, getCompatPreset, createCompatAdapter } from "./providers/api/compat";
import { ApiAgentLoop } from "./providers/api/loop";
import { ToolExecutor } from "./providers/api/tools";
import { AnthropicApiAdapter } from "./providers/api/anthropic";
import { OpenAIApiAdapter } from "./providers/api/openai";
import { GoogleApiAdapter } from "./providers/api/google";
import { resolveApiKey } from "../core/api-keys";

const PROVIDERS: Record<string, new (config: Record<string, unknown>) => BaseProvider> = {
  anthropic: AnthropicProvider,
  openai: OpenAIProvider,
  google: GoogleProvider,
};

const _cache = new Map<string, Agent>();

/** 记录已警告过的废弃 string agent，避免每次解析都刷屏 */
const _warnedLegacyString = new Set<string>();

// ── Provider 路由 ──

/**
 * 决定 phase 应使用 CLI 还是 API 模式。
 *
 * 优先级：
 *   1. phase 内联 agent 显式指定 mode
 *   2. provider 级默认 mode
 *   3. compat-only provider 强制 api
 *   4. 三大官方默认 cli（向后兼容）
 */
export function resolveMode(
  phaseMode: AgentMode | undefined,
  providerCfg: ProviderConfig | undefined,
  providerName: string,
): AgentMode {
  // 1. phase 内联 agent 显式指定
  if (phaseMode) {
    if (phaseMode === "cli" && isCompatOnlyProvider(providerName)) {
      throw new Error(`Provider "${providerName}" 仅支持 API 模式，不能设置 mode: cli`);
    }
    return phaseMode;
  }
  // 2. provider 级默认
  if (providerCfg?.mode) return providerCfg.mode as AgentMode;
  // 3. compat provider 强制 api
  if (isCompatOnlyProvider(providerName)) return "api";
  // 4. 三大官方默认 cli
  return "cli";
}

/**
 * 根据配置创建 Agent 实例（不缓存）。
 * 传入的 config 必须已合并完成（包含 provider 等字段）。
 */
export function createAgent(config: AgentConfig): Agent {
  const providerName = config.provider ?? "anthropic";
  const providerCfg = loadProviders()[providerName];
  const mode = resolveMode(config.mode, providerCfg, providerName);

  if (mode === "cli") {
    // CLI 模式：使用现有 provider 子进程
    const ProviderClass = PROVIDERS[providerName];
    if (!ProviderClass) {
      throw new Error(`未知 provider：${providerName}，CLI 模式支持：${Object.keys(PROVIDERS).join("、")}`);
    }
    const provider = new ProviderClass(config as unknown as Record<string, unknown>);
    return new Agent(config.name, provider, config, "cli");
  }

  // API 模式：返回占位 Agent，apiLoop 在首次 run() 时惰性初始化
  // 先用一个 dummy provider（API 模式下不走 provider.run）
  const dummyProvider = {
    config: config as unknown as Record<string, unknown>,
    run: async () => { throw new Error("API 模式不应调用 provider.run，应通过 apiLoop.run() 执行"); },
    close: async () => {},
    chat: async () => { throw new Error("API 模式不应调用 provider.chat"); },
    buildRunOptions: () => ({}),
    resolveModel: () => config.model ?? "unknown",
    resolveMaxTurns: () => config.max_turns ?? 10,
    resolveSystemPrompt: () => config.system_prompt,
  } as unknown as BaseProvider;

  const agent = new Agent(config.name, dummyProvider, config, "api");
  // 注入惰性初始化工厂：Agent.run() 首次调用时自动执行，返回 ApiAgentLoop 实例
  agent.setApiLoopFactory(async (sandboxRoot: string) => {
    return await createApiAgentLoop(agent.config, sandboxRoot);
  });
  return agent;
}

/**
 * 创建 API 模式的 ApiAgentLoop 实例。
 * 需要异步操作（resolveApiKey）。
 * 返回 ApiAgentLoop，由 Agent 内部自行持有。
 */
async function createApiAgentLoop(config: AgentConfig, sandboxRoot: string): Promise<ApiAgentLoop> {
  const providerName = config.provider ?? "anthropic";
  const providerCfg = loadProviders()[providerName];

  const apiKey = await resolveApiKey(providerName, providerCfg?.env_key_name);
  if (!apiKey) {
    throw new Error(
      `Provider "${providerName}" 的 API key 未配置。\n` +
      "请通过以下方式之一配置：\n" +
      `  1. autopilot key set ${providerName}\n` +
      `  2. 设置环境变量（参见文档）\n` +
      `  3. Web UI → 设置 → API Keys`,
    );
  }

  // 创建适配器
  const adapter = createProviderAdapter(providerName, apiKey, providerCfg);
  const toolExecutor = ToolExecutor.fromConfig(sandboxRoot, config.permission_mode);

  return new ApiAgentLoop({
    adapter,
    toolExecutor,
    model: config.model ?? providerCfg?.default_model ?? "unknown",
    systemPrompt: config.system_prompt,
    maxTurns: config.max_turns ?? 10,
    onStream: (delta) => {
      // 推送到 logger（由 event-bus 分发到 WS）
      // 使用 %s 占位符防止 LLM 输出中的 %s/%d 等被当作 printf 格式串解析
      log.info("%s", delta);
    },
  });
}

function createProviderAdapter(
  providerName: string,
  apiKey: string,
  providerCfg?: ProviderConfig,
) {
  const baseUrl = providerCfg?.base_url as string | undefined;

  switch (providerName) {
    case "anthropic":
      return new AnthropicApiAdapter(apiKey, baseUrl || undefined);
    case "openai":
      return new OpenAIApiAdapter(apiKey, baseUrl || undefined);
    case "google":
      return new GoogleApiAdapter(apiKey, baseUrl || undefined);
    default: {
      // compat provider（预置或自定义）
      const preset = getCompatPreset(providerName);
      const compatBaseUrl = baseUrl || preset?.base_url;
      if (!compatBaseUrl) {
        throw new Error(
          `自定义 provider "${providerName}" 需要在 config.yaml 中配置 base_url。\n` +
          "示例：\n  providers:\n    " + providerName + ":\n      base_url: https://api.example.com/v1",
        );
      }
      return createCompatAdapter(apiKey, compatBaseUrl, providerName);
    }
  }
}

/**
 * 按 phase 解析并构建 Agent（spec：已移除命名复用 agent）。
 *
 * 解析规则：
 *   - phase.agent 是对象 → 内联配置覆盖 DEFAULT_AGENT，model 缺失走 providers.<provider>.default_model
 *   - phase.agent 省略   → 直接用 DEFAULT_AGENT
 *   - phase.agent 是字符串 → 已废弃的命名 agent 引用：warn 一次后按 DEFAULT_AGENT 兜底跑
 *
 * 缓存 key 用 `workflowName:@phase:phaseName:mode`；
 * closeAgents/clearAllAgentCache 用 `workflowName:` 前缀仍能清理到（防 provider 子进程泄漏）。
 */
export function agentForPhase(workflowName: string, phaseName: string): Agent {
  const phase = getPhase(workflowName, phaseName);
  const spec = phase?.agent;

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
  const providerCfg = loadProviders()[provider];
  if (!merged["model"]) {
    if (providerCfg?.default_model) merged["model"] = providerCfg.default_model;
  }

  // 解析 mode（用于缓存 key 和 Agent 构建）
  const mode = resolveMode(
    merged["mode"] as AgentMode | undefined,
    providerCfg,
    provider,
  );

  // 缓存 key 含 mode，避免同一 phase 在 mode 变更后使用旧实例
  const cacheKey = `${workflowName}:@phase:${phaseName}:${mode}`;
  const cached = _cache.get(cacheKey);
  if (cached) return cached;

  // 匿名 agent：用 phase 名做标识（日志 / header / 缓存）
  merged["name"] = phaseName;
  merged["mode"] = mode;

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
