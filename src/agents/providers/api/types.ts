/**
 * API 模式 Provider 适配器公共类型定义。
 */

import type { ToolDefinition } from "./tools";

// ── 消息类型 ──

export interface MessageParam {
  role: "system" | "user" | "assistant" | "tool_result";
  content: string | ContentBlock[] | ToolResultContent[];
  /** tool_result 消息时指定对应的 tool_use_id */
  tool_use_id?: string;
}

export interface ContentBlock {
  type: "text" | "tool_use";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export interface ToolResultContent {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
  /** 工具名（Google Gemini 要求 functionResponse.name 与 functionCall.name 匹配） */
  name?: string;
}

// ── 工具调用 ──

export interface ToolUseBlock {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// ── 适配器响应 ──

export interface AdapterResponse {
  /** 纯文本输出（OpenAI 兼容适配器在 content 为空时可能回退为 reasoning_content，此时 reasoningFallback=true） */
  text: string;
  /**
   * true = text 字段使用了 reasoning 内容作为回退（非真实 assistant content）。
   * 消费侧（如日志）据此跳过记录，避免把推理长文写入运行日志。
   */
  reasoningFallback?: boolean;
  /** 工具调用列表 */
  toolCalls?: ToolUseBlock[];
  /** 用量统计 */
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  /** 停止原因 */
  stopReason: string;
}

// ── 工具选择强制 ──

/**
 * 强制工具选择（结构化输出用）。`type:"force"` = 模型本轮**必须**调用名为 `name` 的工具，
 * 不得只回散文。各 adapter 翻译成自家格式（anthropic tool_choice / openai tool_choice /
 * google functionCallingConfig.mode=ANY）。供 completeStructured 把自由散文收敛成结构化结论。
 */
export type ToolChoice = { type: "force"; name: string };

// ── 适配器选项 ──

export interface AdapterOptions {
  model: string;
  max_tokens?: number;
  tools?: ToolDefinition[];
  /** 强制模型调用指定工具（结构化输出）。缺省 = 模型自由决定是否调工具。 */
  tool_choice?: ToolChoice;
  /**
   * 结构化判据专用：要求模型本次**不思考**直接给结构化结论。部分思考原生端点（如 Kimi Code）
   * 在思考开启时拒绝强制 tool_choice（400），需关思考。各 adapter 按自家端点翻译（仅必要端点生效，
   * 其余无操作）。普通 agent 调用不设此项，思考照常。
   */
  disable_thinking?: boolean;
  stop_sequences?: string[];
  temperature?: number;
  signal?: AbortSignal;
}

// ── 适配器接口 ──

export interface ProviderAdapter {
  /** 适配器名称 */
  readonly name: string;
  /**
   * 流式完成调用。
   * @param messages 消息列表（含 system/user/assistant/tool_result）
   * @param options 模型参数
   * @param onDelta 文本增量回调（实时推流）
   */
  completeStream(
    messages: MessageParam[],
    options: AdapterOptions,
    onDelta?: (delta: string) => void,
  ): Promise<AdapterResponse>;
}
