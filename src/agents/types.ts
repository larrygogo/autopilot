/** 预置 OpenAI 兼容供应商（命名已预置 base_url，用户只需提供 key） */
export type BuiltinCompatProvider = "deepseek" | "kimi" | "minimax";

/** 三大官方 + 预置兼容 + 自定义 compat provider */
export type ProviderName = "anthropic" | "openai" | "google" | BuiltinCompatProvider | (string & {});

/** Agent 接入方式：CLI 子进程 或 HTTP API 直连 */
export type AgentMode = "cli" | "api";

/**
 * Agent 定义。可出现在：
 *   - 全局 config.yaml 的 `agents.<name>`（无需 name 字段，以 key 为名）
 *   - 工作流 workflow.yaml 的 `agents[]`（可用 `extends` 指定全局同名基底）
 *
 * 合并顺序：global[extends || name] → workflow 覆盖 → 调用时 RunOptions 覆盖。
 */
export interface AgentConfig {
  name: string;
  /** 显示名（UI 显示），未填则回退到 name */
  label?: string;
  /** 继承全局 agent 的 key（默认继承同名）；设为 null/false 关闭继承 */
  extends?: string | null | false;
  provider?: ProviderName;
  model?: string;
  /** 接入方式：cli（子进程）或 api（HTTP 直连）。不填则继承 provider 级或按默认规则 */
  mode?: AgentMode;
  permission_mode?: string;
  /** 工具能力白名单（细粒度授权，见 tool-capabilities.ts）。缺省=全集；与 permission_mode 正交。第一刀仅 API agent 生效。 */
  tools?: string[];
  max_turns?: number;
  /**
   * ⚠ reserved（未接线）：声明存在但无任何读取/比较/中断逻辑——ApiAgentLoop 只累计 token、不算
   * cost、不对照此值。供未来「预算护栏 / 烧钱止损」用（见 docs/superpowers/specs/
   * 2026-06-14-fine-grained-tool-capabilities.md）。当前 API agent 唯一硬上限是 max_turns + idle
   * timeout。勿在 UI 上把它当生效护栏宣传；真接入须按正式 spec 走（按价目表累计 cost + 优雅中断）。
   */
  max_budget_usd?: number;
  system_prompt?: string;
  [key: string]: unknown;
}

export interface AgentResult {
  text: string;
  usage?: {
    /** 未走缓存的新输入 token（Anthropic 开 prompt cache 时只是零头，真实输入看 cache 两项） */
    input_tokens?: number;
    output_tokens?: number;
    /** prompt cache 写入量（按 1.25x 计价的部分） */
    cache_creation_input_tokens?: number;
    /** prompt cache 命中读取量（agent loop 的输入大头） */
    cache_read_input_tokens?: number;
    total_cost_usd?: number;
  };
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
  /**
   * 注入/覆盖 agent 子进程的环境变量（L0 环境隔离）。
   * task 执行时由 Agent.run 自动注入 AUTOPILOT_HOME=沙箱内隔离 home，防 agent 跑 autopilot
   * 命令污染用户真实 daemon/DB（沙箱此前只隔离代码、未隔离运行时）。
   */
  env?: Record<string, string>;
}

// ──────────────────────────────────────────────
// 对话（chat）接口：多轮、session 绑定
// ──────────────────────────────────────────────

export interface ChatOptions {
  /** provider 原生 session id；传入则续该 session */
  providerSessionId?: string;
  /** 取消信号 */
  signal?: AbortSignal;
  /** 临时覆盖模型 */
  model?: string;
  /** 覆盖 system_prompt */
  system_prompt?: string;
  /** 追加到 system_prompt 之后 */
  additional_system?: string;
  cwd?: string;
  timeout?: number;
  /**
   * 流式 delta 回调。实现此参数的 provider 会在生成过程中逐段触发，
   * 供 UI 做打字机效果或 WebSocket 推流。
   */
  onDelta?: (delta: string) => void;
  /**
   * 开启 autopilot 内建工具集（list_tasks / start_task / ...）。
   * 对话 agent 用；工作流阶段里的 run() 调用不走这里。
   */
  enableTools?: boolean;
  /**
   * 工具调用生命周期通知。UI 可用于显示"正在调用 XX 工具..."。
   */
  onToolUse?: (event: { tool: string; phase: "start" | "end"; input?: unknown }) => void;
}

export interface ChatResult {
  /** assistant 的回复文本 */
  text: string;
  /** provider 本次返回的 session id（后续续对话用） */
  providerSessionId?: string;
  /** 形状与 AgentResult["usage"] 一致（含 prompt cache 读/写 token） */
  usage?: AgentResult["usage"];
}
