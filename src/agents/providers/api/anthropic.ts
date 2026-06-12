/**
 * Anthropic Messages API 流式适配器。
 *
 * 使用原生 fetch + SSE 解析（不依赖 @anthropic-ai/sdk），保持零 npm 依赖原则。
 * 支持 stream: true 模式下的 content_block_delta 事件。
 */

import type { ProviderAdapter, AdapterOptions, AdapterResponse, MessageParam, ContentBlock, ToolUseBlock } from "./types";

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";

export class AnthropicApiAdapter implements ProviderAdapter {
  readonly name = "anthropic";

  constructor(
    private apiKey: string,
    private baseUrl: string = DEFAULT_BASE_URL,
  ) {}

  async completeStream(
    messages: MessageParam[],
    options: AdapterOptions,
    onDelta?: (delta: string) => void,
  ): Promise<AdapterResponse> {
    const url = `${this.baseUrl}/v1/messages`;

    // 转换消息格式为 Anthropic 格式
    const { system, anthropicMessages } = convertMessages(messages);

    const body: Record<string, unknown> = {
      model: options.model,
      max_tokens: options.max_tokens || 8192,
      messages: anthropicMessages,
      stream: true,
    };
    if (system) body["system"] = system;
    if (options.tools && options.tools.length > 0) {
      body["tools"] = options.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      }));
    }
    if (options.stop_sequences) body["stop_sequences"] = options.stop_sequences;
    if (options.temperature !== undefined) body["temperature"] = options.temperature;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": API_VERSION,
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new ApiError(response.status, `Anthropic API 错误 (${response.status}): ${errorBody}`);
    }

    return this._parseSSE(response.body!, onDelta);
  }

  private async _parseSSE(
    stream: ReadableStream<Uint8Array>,
    onDelta?: (delta: string) => void,
  ): Promise<AdapterResponse> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    const contentBlocks: ContentBlock[] = [];
    const toolCalls: ToolUseBlock[] = [];
    let currentToolInput = "";
    let currentToolIndex = -1;
    let usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    let stopReason: string | null = null;

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        let nlIdx: number;
        while ((nlIdx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nlIdx).trim();
          buf = buf.slice(nlIdx + 1);

          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") continue;

          let event: Record<string, unknown>;
          try {
            event = JSON.parse(data);
          } catch {
            continue;
          }

          const type = event["type"] as string;

          if (type === "content_block_start") {
            const block = event["content_block"] as Record<string, unknown>;
            if (block["type"] === "tool_use") {
              currentToolIndex = toolCalls.length;
              toolCalls.push({
                id: block["id"] as string,
                name: block["name"] as string,
                input: {},
              });
              currentToolInput = "";
            } else if (block["type"] === "text") {
              contentBlocks.push({ type: "text", text: "" });
            }
          } else if (type === "content_block_delta") {
            const delta = event["delta"] as Record<string, unknown>;
            if (delta["type"] === "text_delta") {
              const text = delta["text"] as string;
              if (contentBlocks.length > 0) {
                const last = contentBlocks[contentBlocks.length - 1];
                if (last.type === "text") last.text += text;
              }
              if (onDelta) onDelta(text);
            } else if (delta["type"] === "input_json_delta") {
              currentToolInput += delta["partial_json"] as string;
            }
          } else if (type === "content_block_stop") {
            if (currentToolIndex >= 0 && currentToolInput) {
              try {
                toolCalls[currentToolIndex].input = JSON.parse(currentToolInput);
              } catch {
                toolCalls[currentToolIndex].input = { _raw: currentToolInput };
              }
              currentToolIndex = -1;
              currentToolInput = "";
            }
          } else if (type === "message_delta") {
            const delta = event["delta"] as Record<string, unknown>;
            if (delta["stop_reason"]) stopReason = delta["stop_reason"] as string;
            const deltaUsage = event["usage"] as Record<string, number> | undefined;
            if (deltaUsage) {
              usage.output_tokens = deltaUsage["output_tokens"] ?? usage.output_tokens;
            }
          } else if (type === "message_start") {
            const msg = event["message"] as Record<string, unknown>;
            const msgUsage = msg["usage"] as Record<string, number> | undefined;
            if (msgUsage) {
              usage.input_tokens = msgUsage["input_tokens"] ?? 0;
              usage.cache_creation_input_tokens = msgUsage["cache_creation_input_tokens"] ?? 0;
              usage.cache_read_input_tokens = msgUsage["cache_read_input_tokens"] ?? 0;
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // 合并文本内容
    const text = contentBlocks
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    return {
      text,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
      stopReason: stopReason ?? "end_turn",
    };
  }
}

// ── 消息格式转换 ──

function convertMessages(
  messages: MessageParam[],
): { system: string | undefined; anthropicMessages: Record<string, unknown>[] } {
  let system: string | undefined;
  const anthropicMessages: Record<string, unknown>[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      system = msg.content as string;
      continue;
    }
    if (msg.role === "tool_result") {
      // Anthropic 用 "user" role + tool_result content
      anthropicMessages.push({
        role: "user",
        content: Array.isArray(msg.content) ? msg.content : [
          { type: "tool_result", tool_use_id: msg.tool_use_id, content: msg.content as string },
        ],
      });
      continue;
    }
    // assistant / user 直接传
    anthropicMessages.push({
      role: msg.role,
      content: msg.content,
    });
  }

  return { system, anthropicMessages };
}

// ── 错误类型 ──

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}
