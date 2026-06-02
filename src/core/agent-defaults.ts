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
  /** 显示名（UI 显示），未填则回退到 name 标识符 */
  label?: string;
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
    label: "编码助手",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    max_turns: 10,
    permission_mode: "auto",
    system_prompt:
      "你是通用编码助手。读上下文 → 提出方案 → 实施 → 自查。" +
      "代码注释和 commit message 用中文，代码本身用英文；遵循项目已有风格。",
  },
  reviewer: {
    label: "评审员",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    max_turns: 5,
    permission_mode: "default",
    system_prompt:
      "你是代码审查员。关注正确性、可读性、边界与失败处理。" +
      "找出真问题而非格式纠错；按 critical / important / minor 分级反馈。",
  },
  clarifier: {
    label: "需求分析师",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    max_turns: 3,
    permission_mode: "default",
    system_prompt:
      "你是需求分析师。读用户的口语化描述，识别歧义和缺漏 → 用结构化提问澄清；" +
      "已经清晰的部分不要重复确认。每次输出严格 JSON。",
  },
  workflow_author: {
    label: "工作流作者",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    max_turns: 3,
    permission_mode: "default",
    system_prompt:
      "你是 autopilot 工作流作者。读用户描述生成 workflow.yaml + workflow.ts，每次输出严格 JSON。" +
      "yaml 必须为工作流本身填 label（顶层），并为每个 phase 和 agent 都填 label（用户描述语言；通常是中文）。",
  },
};

export const AGENT_DEFAULT_NAMES = Object.keys(AGENT_DEFAULTS);

/**
 * Phase 内联 agent 配置（spec：移除命名复用 agent）。
 *
 * 工作流不再引用命名 agent，而是在 phase 上就地挂一个匿名配置对象：
 *   phases:
 *     - name: design
 *       agent: { provider: anthropic, model: claude-opus-4-8, system_prompt: ... }
 *
 * 整段 `agent:` 可省略——省略时走 DEFAULT_AGENT 兜底。
 * 字段语义与 AgentConfig 同构（去掉 name/extends 这类「命名复用」专属字段）。
 */
export interface InlineAgentConfig {
  label?: string;
  provider?: "anthropic" | "openai" | "google";
  model?: string;
  max_turns?: number;
  permission_mode?: string;
  system_prompt?: string;
  [key: string]: unknown;
}

/**
 * 单一无名默认 agent——phase 不配 `agent:` 时的兜底。
 *
 * 取代旧的「命名 AGENT_DEFAULTS + 三层合并」：现在没有"按名取用"，
 * 只有「phase 内联覆盖 DEFAULT_AGENT」两层。model 缺失时再走
 * providers.<provider>.default_model（见 agentForPhase）。
 */
export const DEFAULT_AGENT: InlineAgentConfig & { provider: "anthropic" | "openai" | "google" } = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  max_turns: 10,
  permission_mode: "auto",
  system_prompt:
    "你是通用编码助手。读上下文 → 提出方案 → 实施 → 自查。" +
    "代码注释和 commit message 用中文，代码本身用英文；遵循项目已有风格。",
};
