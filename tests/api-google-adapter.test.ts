/**
 * Google Gemini API 适配器单元测试。
 *
 * 覆盖 review C2 指出的 functionResponse.name 映射问题：
 *   - tool_result 消息中 name 字段正确传递到 functionResponse
 *   - 多工具调用场景下每个 functionResponse 有正确的 name
 *   - 系统消息、用户消息、assistant 消息格式转换
 */

import { describe, it, expect, mock } from "bun:test";
import { GoogleApiAdapter } from "../src/agents/providers/api/google";
import type { MessageParam, ToolResultContent } from "../src/agents/providers/api/types";

// 通过反射获取 convertMessages 函数（它是模块私有的）
// 我们通过构建完整消息流并检查最终发送的请求体来测试

describe("Google adapter — convertMessages 消息格式转换", () => {
  // 由于 convertMessages 是私有函数，通过 mock fetch 间接测试
  let capturedBody: Record<string, unknown> | undefined;

  it("tool_result 消息中 name 字段正确映射到 functionResponse.name", async () => {
    // Mock global fetch 捕获请求体
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      // 返回一个流式 SSE 响应（最小有效响应）
      const sseData = 'data: {"candidates":[{"content":{"parts":[{"text":"done"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5}}\n\n';
      return new Response(sseData, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    try {
      const adapter = new GoogleApiAdapter("test-key");

      // 构建包含 tool_result 的消息序列
      const messages: MessageParam[] = [
        { role: "user", content: "请读取文件" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "好的，我来读取文件" },
            { type: "tool_use", id: "call_1", name: "read_file", input: { path: "test.txt" } },
          ],
        },
        {
          role: "tool_result",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_1",
              content: "文件内容：hello world",
              name: "read_file",  // C2 修复：从 loop.ts 复制过来的工具名
            } as ToolResultContent,
          ],
        },
      ];

      await adapter.completeStream(messages, { model: "gemini-2.5-flash" });

      // 验证请求体中的 functionResponse.name
      expect(capturedBody).toBeDefined();
      const contents = capturedBody!["contents"] as Array<Record<string, unknown>>;
      expect(contents.length).toBe(3);

      // 第三条消息是 tool_result → 转换为 user role + functionResponse
      const toolResultMsg = contents[2];
      expect(toolResultMsg["role"]).toBe("user");
      const parts = toolResultMsg["parts"] as Array<Record<string, unknown>>;
      expect(parts.length).toBe(1);
      const funcResponse = parts[0]["functionResponse"] as Record<string, unknown>;
      // 关键断言：name 必须是 "read_file"，不是 "tool" 或 "unknown_tool"
      expect(funcResponse["name"]).toBe("read_file");
      expect((funcResponse["response"] as Record<string, unknown>)["result"]).toBe("文件内容：hello world");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("多工具调用场景 — 每个 functionResponse 有正确的 name", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      const sseData = 'data: {"candidates":[{"content":{"parts":[{"text":"完成"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":20,"candidatesTokenCount":3}}\n\n';
      return new Response(sseData, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    try {
      const adapter = new GoogleApiAdapter("test-key");

      const messages: MessageParam[] = [
        { role: "user", content: "读文件并搜索" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "call_1", name: "read_file", input: { path: "a.ts" } },
            { type: "tool_use", id: "call_2", name: "search_files", input: { pattern: "TODO" } },
          ],
        },
        {
          role: "tool_result",
          content: [
            { type: "tool_result", tool_use_id: "call_1", content: "file A content", name: "read_file" } as ToolResultContent,
            { type: "tool_result", tool_use_id: "call_2", content: "line 42: TODO fix", name: "search_files" } as ToolResultContent,
          ],
        },
      ];

      await adapter.completeStream(messages, { model: "gemini-2.5-flash" });

      const contents = capturedBody!["contents"] as Array<Record<string, unknown>>;
      // tool_result 转换为 user 消息
      const toolResultMsg = contents[2];
      const parts = toolResultMsg["parts"] as Array<Record<string, unknown>>;
      expect(parts.length).toBe(2);

      // 每个 functionResponse 的 name 必须与对应的 functionCall.name 匹配
      expect((parts[0]["functionResponse"] as Record<string, unknown>)["name"]).toBe("read_file");
      expect((parts[1]["functionResponse"] as Record<string, unknown>)["name"]).toBe("search_files");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("assistant 消息中的 functionCall 正确转换", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      const sseData = 'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2}}\n\n';
      return new Response(sseData, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    try {
      const adapter = new GoogleApiAdapter("test-key");

      const messages: MessageParam[] = [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me help" },
            { type: "tool_use", id: "call_x", name: "bash", input: { command: "ls" } },
          ],
        },
        {
          role: "tool_result",
          content: [
            { type: "tool_result", tool_use_id: "call_x", content: "file1.txt\nfile2.txt", name: "bash" } as ToolResultContent,
          ],
        },
      ];

      await adapter.completeStream(messages, { model: "gemini-2.5-flash" });

      const contents = capturedBody!["contents"] as Array<Record<string, unknown>>;

      // assistant 消息 → model role
      const modelMsg = contents[1];
      expect(modelMsg["role"]).toBe("model");
      const modelParts = modelMsg["parts"] as Array<Record<string, unknown>>;
      expect(modelParts.length).toBe(2);
      expect(modelParts[0]["text"]).toBe("Let me help");
      const fc = modelParts[1]["functionCall"] as Record<string, unknown>;
      expect(fc["name"]).toBe("bash");
      expect(fc["args"]).toEqual({ command: "ls" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("system 消息转换为 systemInstruction", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      const sseData = 'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":1}}\n\n';
      return new Response(sseData, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    try {
      const adapter = new GoogleApiAdapter("test-key");

      const messages: MessageParam[] = [
        { role: "system", content: "你是一个代码助手" },
        { role: "user", content: "hello" },
      ];

      await adapter.completeStream(messages, { model: "gemini-2.5-flash" });

      expect(capturedBody!["systemInstruction"]).toEqual({
        parts: [{ text: "你是一个代码助手" }],
      });
      // system 消息不应出现在 contents 中
      const contents = capturedBody!["contents"] as Array<Record<string, unknown>>;
      expect(contents.length).toBe(1);
      expect(contents[0]["role"]).toBe("user");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("safetySettings 设置为 BLOCK_NONE（M4）", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      const sseData = 'data: {"candidates":[{"content":{"parts":[{"text":""}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1}}\n\n';
      return new Response(sseData, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    try {
      const adapter = new GoogleApiAdapter("test-key");
      await adapter.completeStream([{ role: "user", content: "test" }], { model: "gemini-2.5-flash" });

      const settings = capturedBody!["safetySettings"] as Array<Record<string, string>>;
      expect(settings.length).toBe(4);
      for (const s of settings) {
        expect(s["threshold"]).toBe("BLOCK_NONE");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("Google adapter — SSE 流式解析", () => {
  it("解析 functionCall 响应", async () => {
    const originalFetch = globalThis.fetch;
    const sseData = [
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"read_file","args":{"path":"test.ts"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":20}}',
      '',
    ].join('\n');

    globalThis.fetch = mock(async () => {
      return new Response(sseData, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    try {
      const adapter = new GoogleApiAdapter("test-key");
      const response = await adapter.completeStream(
        [{ role: "user", content: "read file" }],
        { model: "gemini-2.5-flash" },
      );

      expect(response.toolCalls).toBeDefined();
      expect(response.toolCalls!.length).toBe(1);
      expect(response.toolCalls![0].name).toBe("read_file");
      expect(response.toolCalls![0].input).toEqual({ path: "test.ts" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("流式文本 delta 回调正确触发", async () => {
    const originalFetch = globalThis.fetch;
    const sseData = [
      'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":1}}',
      '',
      'data: {"candidates":[{"content":{"parts":[{"text":" World"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2}}',
      '',
    ].join('\n');

    globalThis.fetch = mock(async () => {
      return new Response(sseData, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    try {
      const adapter = new GoogleApiAdapter("test-key");
      const deltas: string[] = [];
      const response = await adapter.completeStream(
        [{ role: "user", content: "hello" }],
        { model: "gemini-2.5-flash" },
        (delta) => deltas.push(delta),
      );

      expect(response.text).toBe("Hello World");
      expect(deltas).toEqual(["Hello", " World"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("API 错误时抛出 ApiError", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response('{"error":{"message":"Invalid API key"}}', {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    try {
      const adapter = new GoogleApiAdapter("bad-key");
      await expect(
        adapter.completeStream([{ role: "user", content: "test" }], { model: "gemini-2.5-flash" })
      ).rejects.toThrow("Google API 错误 (401)");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
