export interface AgentConfig {
  name: string;
  provider: "anthropic" | "openai" | "google";
  model: string;
  permission_mode?: string;
  max_turns?: number;
  max_budget_usd?: number;
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
}
