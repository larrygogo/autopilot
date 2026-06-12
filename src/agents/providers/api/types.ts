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
  /** 纯文本输出 */
  text: string;
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

// ── 适配器选项 ──

export interface AdapterOptions {
  model: string;
  max_tokens?: number;
  tools?: ToolDefinition[];
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
