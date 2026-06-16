import { Agent } from "./agent";
import type { AgentConfig, ProviderName, AgentMode } from "./types";
import type { BaseProvider } from "./providers/base";
import { AnthropicProvider } from "./providers/anthropic";
import { OpenAIProvider } from "./providers/openai";
import { GoogleProvider } from "./providers/google";
import { getPhase } from "../core/workflow/registry";
import { loadProviders, type ProviderConfig } from "../core/config";
import { DEFAULT_AGENT, type InlineAgentConfig } from "../core/agent-defaults";
import { log } from "../core/logger";
import { getTaskContext } from "../core/task/context";
import { getCompatPreset, createCompatAdapter } from "./providers/api/compat";
import { ApiAgentLoop } from "./providers/api/loop";
import { ToolExecutor } from "./providers/api/tools";
import { unknownCapabilities } from "./tool-capabilities";
import { AnthropicApiAdapter } from "./providers/api/anthropic";
import { OpenAIApiAdapter } from "./providers/api/openai";
import { GoogleApiAdapter } from "./providers/api/google";
import type { ProviderAdapter } from "./providers/api/types";
import { resolveApiKey } from "../core/api-keys";
import { getProviderByName } from "../core/providers";

/** CLI 类型按 subtype 选子进程 provider 类（claude/codex/gemini）。 */
const CLI_PROVIDER_BY_SUBTYPE: Record<string, new (config: Record<string, unknown>) => BaseProvider> = {
  claude: AnthropicProvider,
  codex: OpenAIProvider,
  gemini: GoogleProvider,
};

/** 官方三家 → CLI 子类（兼容回退：无 provider 条目时按 name 合成，对齐迁移前行为）。 */
const OFFICIAL_CLI_SUBTYPE: Record<string, string> = {
  anthropic: "claude",
  openai: "codex",
  google: "gemini",
};

const _cache = new Map<string, Agent>();

/** 影响 agent 行为的字段内容指纹（短哈希）；进 cache key 防字段变更后命中旧实例。 */
function agentConfigFingerprint(merged: Record<string, unknown>): string {
  const relevant = {
    provider: merged["provider"] ?? null,
    model: merged["model"] ?? null,
    system_prompt: merged["system_prompt"] ?? null,
    max_turns: merged["max_turns"] ?? null,
    permission_mode: merged["permission_mode"] ?? null,
    tools: merged["tools"] ?? null,
  };
  return Bun.hash(JSON.stringify(relevant)).toString(36);
}

/** 记录已警告过的废弃 string agent，避免每次解析都刷屏 */
const _warnedLegacyString = new Set<string>();

// ── Provider 路由 ──

/**
 * 决定 phase 应使用 CLI 还是 API 模式 —— **兼容回退路径**（无 provider 条目时，
 * 按 name + config 合成，对齐 provider 条目化迁移前的旧行为）。
 *
 * 优先级：phase 显式 mode → provider 级 config.mode → 非官方强制 api → 官方默认 cli。
 * 条目化后的主路径见 resolveEffectiveProvider（条目的 type 直接定 mode）。
 */
export function resolveMode(
  phaseMode: AgentMode | undefined,
  providerCfg: ProviderConfig | undefined,
  providerName: string,
): AgentMode {
  const isOfficial = providerName in OFFICIAL_CLI_SUBTYPE;
  if (phaseMode) {
    if (phaseMode === "cli" && !isOfficial) {
      throw new Error(`Provider "${providerName}" 仅支持 API 模式，不能设置 mode: cli`);
    }
    return phaseMode;
  }
  if (providerCfg?.mode) return providerCfg.mode as AgentMode;
  if (!isOfficial) return "api"; // 非官方（compat / 自定义）默认 api
  return "cli"; // 官方默认 cli
}

/** provider 条目的有效解析结果（type/subtype + API 专属字段）。 */
export interface EffectiveProvider {
  name: string;
  type: AgentMode; // cli | api
  subtype: string; // cli: claude/codex/gemini/custom；api: anthropic/openai/google/openai-compat
  base_url?: string;
  env_key_name?: string;
  default_model?: string;
}

/** DB 取条目，吞掉「表不存在 / DB 未就绪」（pre-migration / 部分测试）→ null 走回退。 */
function safeGetProviderByName(name: string): ReturnType<typeof getProviderByName> {
  try {
    return getProviderByName(name);
  } catch {
    return null;
  }
}

/**
 * 解析 provider 引用名 → 有效 (type, subtype) + API 字段。
 *
 * 主路径：providers 条目存在 → type=条目.type（phase 显式 mode 若 ≠ 条目 type 报错，断言语义）。
 * 兼容回退：无条目（pre-migration / 测试 / DEFAULT）→ 用 resolveMode + name 合成 subtype（旧行为）。
 */
export function resolveEffectiveProvider(name: string, phaseMode: AgentMode | undefined): EffectiveProvider {
  const entry = safeGetProviderByName(name);
  if (entry) {
    if (phaseMode && phaseMode !== entry.type) {
      throw new Error(`Provider "${name}" 是 ${entry.type} 类型条目，phase 不能指定 mode: ${phaseMode}`);
    }
    return {
      name,
      type: entry.type,
      subtype: entry.subtype,
      base_url: entry.base_url ?? undefined,
      env_key_name: entry.env_key_name ?? undefined,
      default_model: entry.default_model ?? undefined,
    };
  }
  // 兼容回退：无条目
  const cfg = loadProviders()[name];
  const type = resolveMode(phaseMode, cfg, name);
  const isOfficial = name in OFFICIAL_CLI_SUBTYPE;
  const subtype = type === "cli"
    ? (OFFICIAL_CLI_SUBTYPE[name] ?? "custom")
    : (isOfficial ? name : "openai-compat");
  return {
    name,
    type,
    subtype,
    base_url: cfg?.base_url,
    env_key_name: cfg?.env_key_name,
    default_model: cfg?.default_model,
  };
}

/**
 * 该 agent 能否使用框架 MCP 工具（submit_decision / ask_user）。
 *
 * 只有 CLI claude（anthropic provider）接 daemon 的 /mcp（anthropic.ts 唯一注入 mcp-config）。
 * codex/gemini CLI 无 MCP 接线；全部 API 模式（含 openai-compat）走硬编码闭集工具、看不到 MCP。
 * decision mode:tool 据此分叉：true → submit_decision 工具硬契约；false → 文本 JSON 裁决块降级。
 */
export function agentSupportsMcpTools(agent: Agent): boolean {
  if (agent.mode !== "cli") return false;
  try {
    const eff = resolveEffectiveProvider(agent.config.provider ?? "anthropic", agent.config.mode);
    return eff.type === "cli" && eff.subtype === "claude";
  } catch {
    return false;
  }
}

/**
 * 根据配置创建 Agent 实例（不缓存）。
 * 传入的 config 必须已合并完成（包含 provider 等字段）。
 */
export function createAgent(config: AgentConfig): Agent {
  const providerName = config.provider ?? "anthropic";
  const eff = resolveEffectiveProvider(providerName, config.mode);

  if (eff.type === "cli") {
    // CLI 模式：按 subtype 选子进程 provider 类（claude/codex/gemini）
    const ProviderClass = CLI_PROVIDER_BY_SUBTYPE[eff.subtype];
    if (!ProviderClass) {
      throw new Error(
        `provider "${providerName}" 的 CLI 子类型 "${eff.subtype}" 暂不支持执行` +
        `（CLI 类型支持：${Object.keys(CLI_PROVIDER_BY_SUBTYPE).join("、")}）`,
      );
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
  const eff = resolveEffectiveProvider(providerName, config.mode);

  const apiKey = await resolveApiKey(providerName, eff.env_key_name);
  if (!apiKey) {
    throw new Error(
      `Provider "${providerName}" 的 API key 未配置。\n` +
      "请通过以下方式之一配置：\n" +
      `  1. autopilot key set ${providerName}\n` +
      `  2. 设置环境变量（参见文档）\n` +
      `  3. Web UI → 设置 → 提供商`,
    );
  }

  // 创建适配器（按 subtype）
  const adapter = createProviderAdapter(eff, apiKey);
  // 工具授权（细粒度）：config.tools 给定时按白名单收窄；未知能力名 warn + 忽略
  const toolCaps = Array.isArray(config.tools) ? (config.tools as string[]) : undefined;
  if (toolCaps) {
    const unknown = unknownCapabilities(toolCaps);
    if (unknown.length > 0) {
      log.warn("agent %s 的 tools 含未知能力名（已忽略）：%s", config.name, unknown.join(", "));
    }
  }
  const toolExecutor = ToolExecutor.fromConfig(sandboxRoot, config.permission_mode, toolCaps);

  return new ApiAgentLoop({
    adapter,
    toolExecutor,
    model: config.model ?? eff.default_model ?? "unknown",
    systemPrompt: config.system_prompt,
    // ?? 30 是类型必需（DEFAULT_AGENT.max_turns 类型上为可选 number|undefined，虽运行时恒 30）
    maxTurns: config.max_turns ?? DEFAULT_AGENT.max_turns ?? 30,
    // onStream 不再传入：完整文本日志改为每轮结束后一次性记录（log-dedup）。
  });
}

/**
 * 解析「纯 API 适配器」——结构化裁判 / 单次结构化调用（completeStructured）用。
 * 强制 API 语义（不建 ApiAgentLoop / ToolExecutor / 子进程），与 createApiAgentLoop
 * 共用 createProviderAdapter + resolveApiKey。
 *
 * provider 解析：api 类型条目直接用其 subtype/base_url/env；无 api 条目（含 cli 条目 /
 * pre-migration）→ 按官方名合成 api subtype（anthropic/openai/google），其余回退 openai-compat。
 */
export async function resolveApiAdapter(providerName: string): Promise<{
  adapter: ProviderAdapter;
  defaultModel?: string;
}> {
  const entry = safeGetProviderByName(providerName);
  let eff: EffectiveProvider;
  if (entry && entry.type === "api") {
    eff = {
      name: providerName,
      type: "api",
      subtype: entry.subtype,
      base_url: entry.base_url ?? undefined,
      env_key_name: entry.env_key_name ?? undefined,
      default_model: entry.default_model ?? undefined,
    };
  } else {
    const cfg = loadProviders()[providerName];
    const isOfficial = providerName in OFFICIAL_CLI_SUBTYPE;
    eff = {
      name: providerName,
      type: "api",
      subtype: isOfficial ? providerName : "openai-compat",
      base_url: cfg?.base_url,
      env_key_name: cfg?.env_key_name,
      default_model: cfg?.default_model,
    };
  }
  const apiKey = await resolveApiKey(providerName, eff.env_key_name);
  if (!apiKey) {
    throw new Error(
      `结构化调用的 provider "${providerName}" 未配置 API key` +
      `（autopilot key set ${providerName}，或在「设置 → 提供商」配置）`,
    );
  }
  return { adapter: createProviderAdapter(eff, apiKey), defaultModel: eff.default_model };
}

/** 按 provider 条目的 subtype 选 API 适配器。 */
function createProviderAdapter(eff: EffectiveProvider, apiKey: string): ProviderAdapter {
  const baseUrl = eff.base_url || undefined;
  switch (eff.subtype) {
    case "anthropic":
      return new AnthropicApiAdapter(apiKey, baseUrl);
    case "openai":
      return new OpenAIApiAdapter(apiKey, baseUrl);
    case "google":
      return new GoogleApiAdapter(apiKey, baseUrl);
    case "openai-compat":
    default: {
      // compat：base_url 优先取条目，回退内置预置
      const compatBaseUrl = baseUrl || getCompatPreset(eff.name)?.base_url;
      if (!compatBaseUrl) {
        throw new Error(
          `provider "${eff.name}" 需要 base_url（在「设置 → 提供商」编辑该条目，或 config.yaml 配 base_url）。`,
        );
      }
      return createCompatAdapter(apiKey, compatBaseUrl, eff.name);
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

  // 解析有效 provider（条目优先，无条目回退）：拿 type（mode）+ default_model
  const eff = resolveEffectiveProvider(provider, merged["mode"] as AgentMode | undefined);
  const mode = eff.type;

  // model 解析优先级：phase 显式 model > 条目/config 的 default_model > DEFAULT_AGENT 硬编码兜底。
  // ⚠ 不能用 if(!merged["model"])：上面 {...DEFAULT_AGENT, ...inline} 浅合并已把 DEFAULT_AGENT.model
  // （硬编码 claude-sonnet-4-6）填满 merged["model"]，条件永远 false → config 的 default_model 成
  // dead fallback、被静默忽略（违反 agent-defaults/CLAUDE.md「没写 model 回退 default_model」的承诺）。
  // 改显式三级回退：inline.model 是 phase 真实写的值（未写则 undefined，不被 DEFAULT_AGENT 污染）。
  merged["model"] = inline.model ?? eff.default_model ?? DEFAULT_AGENT.model;

  // 缓存 key 含 mode + 内容指纹（provider/model/system_prompt/max_turns/permission_mode/tools）：
  // 任一影响 agent 行为的字段变更 → key 变 → 新实例。防 workflow.yaml 改内联 agent 字段但
  // 未触发 config:updated 全量清缓存时发旧实例（architect 审查；config:updated 仍兜底全清）。
  // 指纹放 key 末尾，不破坏 closeAgents/clearAllAgentCache 的 `workflowName:` 前缀清理。
  //
  // API 模式按 taskId 隔离：API agent 首次 run 把 ToolExecutor.sandboxRoot 冻结到当时 task
  // 的沙盒（agent.ts 读 getTaskContext().sandboxDir）。若 key 不含 taskId，max_concurrent>1
  // 时并发同工作流任务复用同一实例 → read/write/bash 全落首个 task 沙盒（数据正确性+隔离双破坏）。
  // CLI 模式子进程每次 run 拿到正确 per-run cwd，保留跨 task 会话复用，不按 taskId 分裂。
  // 无 task context 的 API 调用落 ':task:no-task'：实际生产路径（prompt-runner / fix-runner）
  // 都在 runWithTaskContext 内拿真 taskId；万一真在无上下文调 API agent，agent.ts 的 run 期
  // sandboxDir 缺失检查会显式报错、clearAllAgentCache 兜底回收，不会静默串到真 task 沙盒。
  const taskScope = mode === "api" ? `:task:${getTaskContext()?.taskId ?? "no-task"}` : "";
  const cacheKey = `${workflowName}:@phase:${phaseName}:${mode}${taskScope}:${agentConfigFingerprint(merged)}`;
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
 * 关闭并清除指定工作流的缓存 Agent。
 *
 * 传 taskId 时只清「本 task 的 API 实例」（key 含 `:task:<id>:`）+ CLI 共享实例，
 * **跳过别的 task 的 API 实例**——否则某个 task 终态会 close 掉并发同工作流兄弟正在用的
 * API agent（use-after-close）。不传 taskId 走旧的全工作流清理（重跑/全清场景）。
 */
export async function closeAgents(workflowName: string, taskId?: string): Promise<void> {
  const prefix = `${workflowName}:`;
  const closePromises: Promise<void>[] = [];

  for (const [key, agent] of _cache.entries()) {
    if (!key.startsWith(prefix)) continue;
    // taskId 指定时：别的 task 的 API 实例（含 :task: 但不是本 task）跳过；CLI 实例（无
    // :task:）与本 task 的 API 实例照清。
    if (taskId && key.includes(":task:") && !key.includes(`:task:${taskId}:`)) continue;
    closePromises.push(agent.close());
    _cache.delete(key);
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
