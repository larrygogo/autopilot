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
