import { createAgent } from "../agents/registry";
import { loadProviders } from "../core/config";
import type { Agent } from "../agents/agent";
import type { ProviderName } from "../core/config";

export interface ClarifierAgentOverride {
  provider?: "anthropic" | "openai" | "google";
  model?: string;
}

/**
 * clarifier agent 的内置默认配置（daemon 层基础设施，不属于任何工作流）。
 *
 * 命名复用 agent 机制移除后，clarifier 不再从 config.yaml.agents 取，
 * 而是在这里就地定义。model 缺省时从对应 provider 的 default_model 补。
 */
const CLARIFIER_DEFAULTS = {
  provider: "anthropic" as ProviderName,
  // 15 turns：需求级浅 clone 就绪时 agent 自主探索（读文件/搜索/git 命令/加深克隆）
  // 需要足够的工具回合
  max_turns: 15,
  // bypassPermissions：headless default 下 Bash 被自动拒，agent 无法跑 git（log/blame/
  // fetch --deepen）—— 探索自主权要求放开。信任级与 dev workflow develop 阶段一致
  // （产品既有先例）；副本是一次性需求级浅 clone，prompt 中明确禁 push/改远程。
  permission_mode: "bypassPermissions",
  system_prompt:
    "你是需求分析师。读用户的口语化描述，识别歧义和缺漏 → 用结构化提问澄清；" +
    "已经清晰的部分不要重复确认。工作目录里有仓库代码时，先自主探索（读文件 / 搜索 / " +
    "git 命令）把项目了解到位再提问——代码能回答的不要问用户，提问机会留给产品意图与取舍。" +
    "每次最终输出严格遵循要求的格式。",
};

/**
 * 解析并实例化 clarifier agent。
 * - 默认走 CLARIFIER_DEFAULTS；model 缺省从 providers.<provider>.default_model 取
 * - 调用方可传 override（req 级覆盖 provider / model 时用）
 * 返回值可被 clarifier 调查阶段、extract 抽取阶段共用。
 */
export function buildClarifierAgent(override: ClarifierAgentOverride = {}): Agent {
  const providers = loadProviders();
  const provider = override.provider ?? CLARIFIER_DEFAULTS.provider;
  let model = override.model;
  if (!model) {
    model = providers[provider]?.default_model;
  }
  return createAgent({
    name: "clarifier",
    provider,
    model,
    max_turns: CLARIFIER_DEFAULTS.max_turns,
    permission_mode: CLARIFIER_DEFAULTS.permission_mode,
    system_prompt: CLARIFIER_DEFAULTS.system_prompt,
  });
}
