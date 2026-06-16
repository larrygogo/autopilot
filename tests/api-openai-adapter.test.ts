/**
 * OpenAI 兼容适配器 SSE 解析回归测试。
 *
 * 守两个实测修复（Kimi Code 接入暴露）：
 *   1. SSE 行 "data:{…}"（冒号后无空格，Kimi Code 发的）也要解析——
 *      原只认 "data: "（带空格）导致整段输出丢空。
 *   2. 推理模型（kimi-for-coding）只流 reasoning_content、content 为空时，
 *      回退用 reasoning 作文本，不丢成空。
 */
import { describe, it, expect, mock } from "bun:test";
import { OpenAIApiAdapter } from "../src/agents/providers/api/openai";
import type { MessageParam } from "../src/agents/providers/api/types";

function mockSSE(lines: string[]): typeof fetch {
  return mock(async () =>
    new Response(lines.join("\n") + "\n", { status: 200, headers: { "Content-Type": "text/event-stream" } }),
  ) as unknown as typeof fetch;
}

const msgs: MessageParam[] = [{ role: "user", content: "hi" }];

describe("OpenAIApiAdapter SSE 解析", () => {
  it('"data:{…}"（无空格，Kimi 风格）能解析出 content', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = mockSSE([
      'data:{"choices":[{"delta":{"content":"你好"},"finish_reason":null}]}',
      'data:{"choices":[{"delta":{"content":"世界"},"finish_reason":"stop"}]}',
      "data:[DONE]",
    ]);
    try {
      const res = await new OpenAIApiAdapter("k", "https://x.test").completeStream(msgs, { model: "m" });
      expect(res.text).toBe("你好世界");
    } finally { globalThis.fetch = orig; }
  });

  it('"data: {…}"（带空格，OpenAI 标准）仍能解析', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = mockSSE([
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}',
      "data: [DONE]",
    ]);
    try {
      const res = await new OpenAIApiAdapter("k", "https://x.test").completeStream(msgs, { model: "m" });
      expect(res.text).toBe("ok");
    } finally { globalThis.fetch = orig; }
  });

  it("只有 reasoning_content、content 为空 → 回退用 reasoning 作文本", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = mockSSE([
      'data:{"choices":[{"delta":{"reasoning_content":"思考A"},"finish_reason":null}]}',
      'data:{"choices":[{"delta":{"reasoning_content":"思考B"},"finish_reason":"stop"}]}',
      "data:[DONE]",
    ]);
    try {
      const res = await new OpenAIApiAdapter("k", "https://x.test").completeStream(msgs, { model: "m" });
      expect(res.text).toBe("思考A思考B");
    } finally { globalThis.fetch = orig; }
  });

  it("content 与 reasoning 都有 → text 取 content（reasoning 仅回退）", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = mockSSE([
      'data:{"choices":[{"delta":{"reasoning_content":"思考"},"finish_reason":null}]}',
      'data:{"choices":[{"delta":{"content":"答案"},"finish_reason":"stop"}]}',
      "data:[DONE]",
    ]);
    try {
      const res = await new OpenAIApiAdapter("k", "https://x.test").completeStream(msgs, { model: "m" });
      expect(res.text).toBe("答案");
    } finally { globalThis.fetch = orig; }
  });
});
