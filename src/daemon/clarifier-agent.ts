import { createAgent } from "../agents/registry";
import { loadProviders, loadLifecycleConfig } from "../core/config";
import { resolveDefaultProvider } from "../core/default-provider";
import { getProviderByName } from "../core/providers";
import type { Agent } from "../agents/agent";
import type { ProviderName } from "../core/config";
import type { InlineAgentConfig } from "../core/agent-defaults";

export interface ClarifierAgentOverride {
  provider?: string;
  model?: string;
}

/**
 * clarify agent 的内置默认配置（代码兜底；零配置时行为）。
 *
 * 生命周期 agent 配置（2026-06-13）：clarify 的生效配置 = CLARIFIER_DEFAULTS ←
 * config.yaml `lifecycle.clarify`（字段级 merge）← 需求级 override（provider/model）。
 * extract / author 共用 buildClarifierAgent，所以一并继承 lifecycle.clarify 的 provider/model
 * /max_turns/permission_mode（各自 system_prompt 在 run() 时覆盖）。
 */
const CLARIFIER_DEFAULTS: InlineAgentConfig = {
  // provider 不写死：缺省走 resolveDefaultProvider()（按用户实际配置派生），见 effectiveClarifyConfig
  // 15 turns：需求级浅 clone 就绪时 agent 自主探索（读文件/搜索/git 命令/加深克隆）需足够回合
  max_turns: 15,
  // bypassPermissions：headless default 下 Bash 被自动拒，agent 无法跑 git —— 探索自主权要求放开
  permission_mode: "bypassPermissions",
  system_prompt:
    "你是需求分析师。读用户的口语化描述，识别歧义和缺漏 → 用结构化提问澄清；" +
    "已经清晰的部分不要重复确认。工作目录里有仓库代码时，先自主探索（读文件 / 搜索 / " +
    "git 命令）把项目了解到位再提问——代码能回答的不要问用户，提问机会留给产品意图与取舍。" +
    "每次最终输出严格遵循要求的格式。",
};

/**
 * clarify agent 的「生效配置 / 用户配置 / 默认」三件（供 buildClarifierAgent 与 lifecycle.list RPC 共用）。
 * 字段级 merge：用户在 config.yaml lifecycle.clarify 写的字段覆盖同名默认，未写的走默认。
 */
export function effectiveClarifyConfig(): {
  effective: InlineAgentConfig;
  userConfig: InlineAgentConfig;
  defaults: InlineAgentConfig;
} {
  const userConfig = (loadLifecycleConfig().clarify ?? {}) as InlineAgentConfig;
  const effective: InlineAgentConfig = { ...CLARIFIER_DEFAULTS, ...userConfig };
  // 用户没显式写 provider → 填解析到的系统默认（让生效配置 + Web 卡片回显真实默认，而非写死 anthropic）
  if (!effective.provider) effective.provider = resolveDefaultProvider();
  return { effective, userConfig, defaults: CLARIFIER_DEFAULTS };
}

/**
 * 解析并实例化 clarifier agent。
 * 生效配置 = lifecycle.clarify（含代码兜底）；override（需求级 provider/model）再叠最上层。
 * model 缺省从 providers.<provider>.default_model 补。clarifier 调查 / extract 抽取 / author 建流共用。
 */
export function buildClarifierAgent(override: ClarifierAgentOverride = {}): Agent {
  const { effective } = effectiveClarifyConfig();
  // effective.provider 已在 effectiveClarifyConfig 里解析过（用户写了则尊重，没写则系统默认）
  const provider = (override.provider ?? effective.provider ?? resolveDefaultProvider()) as string;
  let model = override.model ?? effective.model;
  if (!model) {
    // 条目 default_model（compat provider 的 model 在 DB 条目里）优先，再退 config providers 段
    model = getProviderByName(provider)?.default_model ?? loadProviders()[provider as ProviderName]?.default_model ?? undefined;
  }
  return createAgent({
    name: "clarifier",
    provider,
    model,
    max_turns: effective.max_turns,
    permission_mode: effective.permission_mode,
    system_prompt: effective.system_prompt,
  });
}
