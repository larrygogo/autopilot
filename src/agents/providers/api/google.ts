/**
 * Google Gemini API 流式适配器。
 *
 * 使用原生 fetch + SSE 解析（不依赖 @google/generative-ai SDK）。
 * 安全设置 BLOCK_NONE 防止开发工作流中代码内容被拦截。
 */

import type { ProviderAdapter, AdapterOptions, AdapterResponse, MessageParam, ToolUseBlock } from "./types";
import { ApiError } from "./anthropic";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";

export class GoogleApiAdapter implements ProviderAdapter {
  readonly name = "google";

  constructor(
    private apiKey: string,
    private baseUrl: string = DEFAULT_BASE_URL,
  ) {}

  async completeStream(
    messages: MessageParam[],
    options: AdapterOptions,
    onDelta?: (delta: string) => void,
  ): Promise<AdapterResponse> {
    const model = options.model || "gemini-2.5-flash";
    const url = `${this.baseUrl}/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${this.apiKey}`;

    const { systemInstruction, contents } = convertMessages(messages);

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        maxOutputTokens: options.max_tokens || 8192,
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.stop_sequences ? { stopSequences: options.stop_sequences } : {}),
      },
      // 开发工作流中代码内容（rm -rf、漏洞描述等）会触发默认安全过滤，必须显式设置 BLOCK_NONE
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
      ],
    };

    if (systemInstruction) {
      body["systemInstruction"] = { parts: [{ text: systemInstruction }] };
    }

    if (options.tools && options.tools.length > 0) {
      body["tools"] = [{
        functionDeclarations: options.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        })),
      }];
    }

    if (options.tool_choice) {
      body["toolConfig"] = {
        functionCallingConfig: { mode: "ANY", allowedFunctionNames: [options.tool_choice.name] },
      };
    }

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: options.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new ApiError(response.status, `Google API 错误 (${response.status}): ${errorBody}`);
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
    const toolCalls: ToolUseBlock[] = [];
    let usage = { input_tokens: 0, output_tokens: 0 };
    let stopReason = "stop";

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

          let event: Record<string, unknown>;
          try {
            event = JSON.parse(data);
          } catch {
            continue;
          }

          // 提取候选内容
          const candidates = event["candidates"] as Array<Record<string, unknown>> | undefined;
          if (candidates && candidates.length > 0) {
            const candidate = candidates[0];
            const content = candidate["content"] as Record<string, unknown> | undefined;
            if (content) {
              const parts = content["parts"] as Array<Record<string, unknown>> | undefined;
              if (parts) {
                for (const part of parts) {
                  if (typeof part["text"] === "string") {
                    text += part["text"];
                    if (onDelta) onDelta(part["text"] as string);
                  }
                  if (part["functionCall"]) {
                    const fc = part["functionCall"] as Record<string, unknown>;
                    toolCalls.push({
                      id: `call_${toolCalls.length}`,
                      name: fc["name"] as string,
                      input: (fc["args"] as Record<string, unknown>) || {},
                    });
                  }
                }
              }
            }
            if (candidate["finishReason"]) {
              const reason = candidate["finishReason"] as string;
              stopReason = reason === "STOP" ? "end_turn" : reason.toLowerCase();
            }
          }

          // 用量统计
          const usageMetadata = event["usageMetadata"] as Record<string, number> | undefined;
          if (usageMetadata) {
            usage.input_tokens = usageMetadata["promptTokenCount"] ?? usage.input_tokens;
            usage.output_tokens = usageMetadata["candidatesTokenCount"] ?? usage.output_tokens;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return {
      text,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
      stopReason,
    };
  }
}

// ── 消息格式转换 ──

function convertMessages(
  messages: MessageParam[],
): { systemInstruction: string | undefined; contents: Record<string, unknown>[] } {
  let systemInstruction: string | undefined;
  const contents: Record<string, unknown>[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemInstruction = msg.content as string;
      continue;
    }
    if (msg.role === "user") {
      contents.push({
        role: "user",
        parts: [{ text: msg.content as string }],
      });
    } else if (msg.role === "assistant") {
      const content = msg.content;
      if (Array.isArray(content)) {
        const parts: Record<string, unknown>[] = [];
        for (const block of content) {
          if (typeof block === "string") {
            parts.push({ text: block });
          } else if (block.type === "text") {
            parts.push({ text: block.text });
          } else if (block.type === "tool_use") {
            parts.push({
              functionCall: {
                name: block.name,
                args: block.input,
              },
            });
          }
        }
        contents.push({ role: "model", parts });
      } else {
        contents.push({
          role: "model",
          parts: [{ text: content as string }],
        });
      }
    } else if (msg.role === "tool_result") {
      if (Array.isArray(msg.content)) {
        const parts = (msg.content as unknown as Array<Record<string, unknown>>).map((block) => ({
          functionResponse: {
            // ToolResultContent.name 由 loop.ts 在构建 toolResult 时从 ToolUseBlock.name 复制
            name: (block["name"] as string | undefined) || "unknown_tool",
            response: { result: block["content"] },
          },
        }));
        contents.push({ role: "user", parts });
      } else {
        // 单条 tool_result 消息：尝试从 msg 上取 name（通过 tool_use_id → name 映射），
        // 回落 unknown_tool（不应出现，但防御性处理）
        contents.push({
          role: "user",
          parts: [{
            functionResponse: {
              name: (msg as unknown as { name?: string }).name || "unknown_tool",
              response: { result: msg.content as string },
            },
          }],
        });
      }
    }
  }

  return { systemInstruction, contents };
}
