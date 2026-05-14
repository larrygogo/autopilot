/**
 * 内置默认 agent。
 *
 * 用户 yaml 不写 agents 段也能跑——三个常用 agent 都有合理默认。
 * 用户 yaml 写了同名 agent → 用户字段 override 内置（partial override：只覆盖写了的字段）。
 *
 * 这些是"通用"默认，工作流可以在 workflow.yaml.agents[] 里 extends 同名再做局部调整。
 * 改默认 model 跟 PROVIDER_DEFAULTS 同步——见 src/core/provider-defaults.ts。
 */

export interface AgentDefault {
  provider: "anthropic" | "openai" | "google";
  model: string;
  max_turns?: number;
  permission_mode?: string;
  system_prompt?: string;
}

/**
 * 三个内置 agent：
 *   - coder：通用编码任务（写代码 / 改文件）
 *   - reviewer：审查/评审任务（只读，强调正确性边界）
 *   - clarifier：需求澄清（短轮询，聚焦"问清楚"）
 */
export const AGENT_DEFAULTS: Record<string, AgentDefault> = {
  coder: {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    max_turns: 10,
    permission_mode: "auto",
    system_prompt:
      "你是通用编码助手。读上下文 → 提出方案 → 实施 → 自查。" +
      "代码注释和 commit message 用中文，代码本身用英文；遵循项目已有风格。",
  },
  reviewer: {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    max_turns: 5,
    permission_mode: "readonly",
    system_prompt:
      "你是代码审查员。关注正确性、可读性、边界与失败处理。" +
      "找出真问题而非格式纠错；按 critical / important / minor 分级反馈。",
  },
  clarifier: {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    max_turns: 3,
    permission_mode: "readonly",
    system_prompt:
      "你是需求分析师。读用户的口语化描述，识别歧义和缺漏 → 用结构化提问澄清；" +
      "已经清晰的部分不要重复确认。每次输出严格 JSON。",
  },
};

export const AGENT_DEFAULT_NAMES = Object.keys(AGENT_DEFAULTS);
