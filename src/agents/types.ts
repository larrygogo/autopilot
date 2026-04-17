export type ProviderName = "anthropic" | "openai" | "google";

/**
 * Agent 定义。可出现在：
 *   - 全局 config.yaml 的 `agents.<name>`（无需 name 字段，以 key 为名）
 *   - 工作流 workflow.yaml 的 `agents[]`（可用 `extends` 指定全局同名基底）
 *
 * 合并顺序：global[extends || name] → workflow 覆盖 → 调用时 RunOptions 覆盖。
 */
export interface AgentConfig {
  name: string;
  /** 继承全局 agent 的 key（默认继承同名）；设为 null/false 关闭继承 */
  extends?: string | null | false;
  provider?: ProviderName;
  model?: string;
  permission_mode?: string;
  max_turns?: number;
  max_budget_usd?: number;
  system_prompt?: string;
  [key: string]: unknown;
}

export interface AgentResult {
  text: string;
  usage?: { input_tokens?: number; output_tokens?: number; total_cost_usd?: number };
}

export interface RunOptions {
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
  /** 替换 agent 的 system_prompt */
  system_prompt?: string;
  /** 追加到 agent 的 system_prompt 之后（优先级高于 system_prompt 替换） */
  additional_system?: string;
  /** 临时覆盖模型 */
  model?: string;
  /** 临时覆盖 max_turns */
  max_turns?: number;
}
