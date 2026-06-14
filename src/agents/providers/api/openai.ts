/**
 * OpenAI Chat Completions API 流式适配器。
 *
 * 使用原生 fetch + SSE 解析（不依赖 openai SDK），保持零 npm 依赖原则。
 * 支持 stream: true 模式下的 delta.content / delta.tool_calls 事件。
 */

import type { ProviderAdapter, AdapterOptions, AdapterResponse, MessageParam, ToolUseBlock } from "./types";
import { ApiError } from "./anthropic";

const DEFAULT_BASE_URL = "https://api.openai.com";

export class OpenAIApiAdapter implements ProviderAdapter {
  readonly name = "openai";

  constructor(
    private apiKey: string,
    private baseUrl: string = DEFAULT_BASE_URL,
    /** 可选 User-Agent 覆盖（某些端点如 Kimi Code 按 UA 限定只给编码 Agent 用） */
    private userAgent?: string,
  ) {}

  async completeStream(
    messages: MessageParam[],
    options: AdapterOptions,
    onDelta?: (delta: string) => void,
  ): Promise<AdapterResponse> {
    const url = `${this.baseUrl}/v1/chat/completions`;

    const openaiMessages = convertMessages(messages);
    const body: Record<string, unknown> = {
      model: options.model,
      messages: openaiMessages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (options.max_tokens) body["max_tokens"] = options.max_tokens;
    if (options.tools && options.tools.length > 0) {
      body["tools"] = options.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      }));
    }
    if (options.tool_choice) {
      body["tool_choice"] = { type: "function", function: { name: options.tool_choice.name } };
    }
    if (options.temperature !== undefined) body["temperature"] = options.temperature;
    if (options.stop_sequences) body["stop"] = options.stop_sequences;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        ...(this.userAgent ? { "User-Agent": this.userAgent } : {}),
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new ApiError(response.status, `OpenAI API 错误 (${response.status}): ${errorBody}`);
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

    let text = "";
    // 推理模型（如 kimi-for-coding）先流 reasoning_content（思考）再给 content。
    // 单独累计，content 为空时作回退 —— 否则推理模型整段输出被丢成「(无输出)」。
    let reasoning = "";
    // 流式 tool_calls 拼接：Map<index, { id, name, arguments }>
    const toolCallMap = new Map<number, { id: string; name: string; args: string }>();
    let usage = { input_tokens: 0, output_tokens: 0 };
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

          // SSE 规范里冒号后空格可选：OpenAI 发 "data: {…}"，Kimi Code 发 "data:{…}"。
          // 只认带空格会把 Kimi 的每行都跳过 → 整段输出丢空。统一去前缀 + trim 兼容两者。
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;

          let event: Record<string, unknown>;
          try {
            event = JSON.parse(data);
          } catch {
            continue;
          }

          // 用量统计（stream_options: include_usage）
          const eventUsage = event["usage"] as Record<string, number> | undefined;
          if (eventUsage) {
            usage.input_tokens = eventUsage["prompt_tokens"] ?? usage.input_tokens;
            usage.output_tokens = eventUsage["completion_tokens"] ?? usage.output_tokens;
          }

          const choices = event["choices"] as Array<Record<string, unknown>> | undefined;
          if (!choices || choices.length === 0) continue;

          const choice = choices[0];
          if (choice["finish_reason"]) {
            stopReason = choice["finish_reason"] as string;
          }

          const delta = choice["delta"] as Record<string, unknown> | undefined;
          if (!delta) continue;

          // 文本增量
          if (typeof delta["content"] === "string") {
            text += delta["content"];
            if (onDelta) onDelta(delta["content"] as string);
          }
          // 推理增量（reasoning_content）：推送以便进度可见 + 累计作 content 空时的回退
          if (typeof delta["reasoning_content"] === "string") {
            reasoning += delta["reasoning_content"];
            if (onDelta) onDelta(delta["reasoning_content"] as string);
          }

          // 工具调用增量
          const deltaToolCalls = delta["tool_calls"] as Array<Record<string, unknown>> | undefined;
          if (deltaToolCalls) {
            for (const tc of deltaToolCalls) {
              const idx = tc["index"] as number;
              const fn = tc["function"] as Record<string, unknown> | undefined;

              if (!toolCallMap.has(idx)) {
                toolCallMap.set(idx, {
                  id: (tc["id"] as string) || "",
                  name: fn?.["name"] as string || "",
                  args: "",
                });
              }

              const entry = toolCallMap.get(idx)!;
              if (tc["id"]) entry.id = tc["id"] as string;
              if (fn?.["name"]) entry.name = fn["name"] as string;
              if (fn?.["arguments"]) entry.args += fn["arguments"] as string;
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // 构建 toolCalls
    const toolCalls: ToolUseBlock[] = [];
    for (const [, entry] of [...toolCallMap.entries()].sort((a, b) => a[0] - b[0])) {
      let input: Record<string, unknown> = {};
      try {
        if (entry.args) input = JSON.parse(entry.args);
      } catch {
        input = { _raw: entry.args };
      }
      toolCalls.push({ id: entry.id, name: entry.name, input });
    }

    return {
      // content 为空（推理模型整段都是 reasoning）时回退用 reasoning，避免输出丢成空
      text: text || reasoning,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
      stopReason: stopReason ?? "stop",
    };
  }
}

// ── 消息格式转换 ──

function convertMessages(messages: MessageParam[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      result.push({ role: "system", content: msg.content as string });
    } else if (msg.role === "user") {
      result.push({ role: "user", content: msg.content as string });
    } else if (msg.role === "assistant") {
      const content = msg.content;
      // 如果 content 包含 tool_use blocks，转换为 OpenAI 格式
      if (Array.isArray(content)) {
        let textParts = "";
        const toolCalls: Record<string, unknown>[] = [];
        for (const block of content) {
          if (typeof block === "string") {
            textParts += block;
          } else if (block.type === "text") {
            textParts += block.text;
          } else if (block.type === "tool_use") {
            toolCalls.push({
              id: block.id,
              type: "function",
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input),
              },
            });
          }
        }
        const assistantMsg: Record<string, unknown> = { role: "assistant" };
        if (textParts) assistantMsg["content"] = textParts;
        if (toolCalls.length > 0) assistantMsg["tool_calls"] = toolCalls;
        result.push(assistantMsg);
      } else {
        result.push({ role: "assistant", content });
      }
    } else if (msg.role === "tool_result") {
      // OpenAI 用 "tool" role
      if (Array.isArray(msg.content)) {
        // 多个 tool_result
        for (const block of msg.content) {
          if (block.type === "tool_result") {
            result.push({
              role: "tool",
              tool_call_id: block.tool_use_id,
              content: typeof block.content === "string" ? block.content : JSON.stringify(block.content),
            });
          }
        }
      } else {
        result.push({
          role: "tool",
          tool_call_id: msg.tool_use_id,
          content: msg.content as string,
        });
      }
    }
  }

  return result;
}
