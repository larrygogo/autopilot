/**
 * 结构化输出底座（声明式工作流砖 3）：
 *   - completeStructuredWith：强制 tool_choice 透传 + 从 toolCalls 解析结构化结论 + 不守约抛错
 *   - 三家 adapter 把 AdapterOptions.tool_choice 翻译成各自 body 格式（fetch 拦截验 body）
 */
import { describe, it, expect } from "bun:test";
import { completeStructuredWith, type StructuredToolSpec } from "../src/agents/structured";
import type {
  ProviderAdapter,
  AdapterOptions,
  AdapterResponse,
  MessageParam,
} from "../src/agents/providers/api/types";
import { AnthropicApiAdapter } from "../src/agents/providers/api/anthropic";
import { OpenAIApiAdapter } from "../src/agents/providers/api/openai";
import { GoogleApiAdapter } from "../src/agents/providers/api/google";

const VERDICT_TOOL: StructuredToolSpec = {
  name: "submit_verdict",
  description: "提交评审结论",
  input_schema: {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["pass", "reject"] },
      reason: { type: "string" },
    },
    required: ["verdict", "reason"],
  },
};

const msgs: MessageParam[] = [{ role: "user", content: "review this" }];

/** 录制 options 并返回预设 toolCalls 的假 adapter。 */
function fakeAdapter(resp: Partial<AdapterResponse>): {
  adapter: ProviderAdapter;
  seen: { options?: AdapterOptions };
} {
  const seen: { options?: AdapterOptions } = {};
  const adapter: ProviderAdapter = {
    name: "fake",
    async completeStream(_m, options): Promise<AdapterResponse> {
      seen.options = options;
      return { text: "", usage: { input_tokens: 0, output_tokens: 0 }, stopReason: "tool_use", ...resp };
    },
  };
  return { adapter, seen };
}

describe("completeStructuredWith", () => {
  it("强制 tool_choice + 单工具透传，解析 toolCalls 入参", async () => {
    const { adapter, seen } = fakeAdapter({
      toolCalls: [{ id: "t1", name: "submit_verdict", input: { verdict: "reject", reason: "缺测试" } }],
    });
    const out = await completeStructuredWith<{ verdict: string; reason: string }>(adapter, {
      model: "m",
      messages: msgs,
      tool: VERDICT_TOOL,
    });
    expect(out.verdict).toBe("reject");
    expect(out.reason).toBe("缺测试");
    // tool_choice 强制 + 只挂这一个工具
    expect(seen.options?.tool_choice).toEqual({ type: "force", name: "submit_verdict" });
    expect(seen.options?.tools?.map((t) => t.name)).toEqual(["submit_verdict"]);
  });

  it("模型不调工具（无 toolCalls）→ 抛错（不退回散文）", async () => {
    const { adapter } = fakeAdapter({ text: "我觉得可以通过", toolCalls: undefined });
    await expect(
      completeStructuredWith(adapter, { model: "m", messages: msgs, tool: VERDICT_TOOL }),
    ).rejects.toThrow(/未遵守 tool_choice|未拿到工具调用/);
  });

  it("工具入参 JSON 解析失败（_raw）→ 抛错", async () => {
    const { adapter } = fakeAdapter({
      toolCalls: [{ id: "t1", name: "submit_verdict", input: { _raw: '{"verdict":"pa' } }],
    });
    await expect(
      completeStructuredWith(adapter, { model: "m", messages: msgs, tool: VERDICT_TOOL }),
    ).rejects.toThrow(/JSON 解析失败/);
  });

  it("toolCalls 名字不匹配时退回第一个 toolCall", async () => {
    const { adapter } = fakeAdapter({
      toolCalls: [{ id: "t1", name: "other", input: { verdict: "pass", reason: "ok" } }],
    });
    const out = await completeStructuredWith<{ verdict: string }>(adapter, {
      model: "m",
      messages: msgs,
      tool: VERDICT_TOOL,
    });
    expect(out.verdict).toBe("pass");
  });
});

// ── adapter tool_choice body 翻译（fetch 拦截）──

/** 拦截 fetch，录制请求 body，返回最小可解析的空 SSE。 */
function captureBody(sse: string): { restore: () => void; body: () => Record<string, unknown> } {
  const orig = globalThis.fetch;
  let captured: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    captured = init?.body ? JSON.parse(init.body) : {};
    return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return { restore: () => { globalThis.fetch = orig; }, body: () => captured };
}

const FORCE: AdapterOptions = { model: "m", tool_choice: { type: "force", name: "submit_verdict" }, tools: [VERDICT_TOOL] };

describe("adapter tool_choice 翻译", () => {
  it("anthropic → tool_choice {type:tool, name}", async () => {
    const cap = captureBody('data: {"type":"message_stop"}\n');
    try {
      await new AnthropicApiAdapter("k", "https://x.test").completeStream(msgs, FORCE);
      expect(cap.body()["tool_choice"]).toEqual({ type: "tool", name: "submit_verdict" });
    } finally { cap.restore(); }
  });

  it("openai → tool_choice {type:function, function:{name}}", async () => {
    const cap = captureBody("data: [DONE]\n");
    try {
      await new OpenAIApiAdapter("k", "https://x.test").completeStream(msgs, FORCE);
      expect(cap.body()["tool_choice"]).toEqual({ type: "function", function: { name: "submit_verdict" } });
    } finally { cap.restore(); }
  });

  it("google → toolConfig.functionCallingConfig mode=ANY + allowedFunctionNames", async () => {
    const cap = captureBody("data: {}\n");
    try {
      await new GoogleApiAdapter("k", "https://x.test").completeStream(msgs, FORCE);
      expect(cap.body()["toolConfig"]).toEqual({
        functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["submit_verdict"] },
      });
    } finally { cap.restore(); }
  });

  it("不传 tool_choice → body 无该字段（默认行为不变）", async () => {
    const cap = captureBody('data: {"type":"message_stop"}\n');
    try {
      await new AnthropicApiAdapter("k", "https://x.test").completeStream(msgs, { model: "m" });
      expect(cap.body()["tool_choice"]).toBeUndefined();
    } finally { cap.restore(); }
  });
});
