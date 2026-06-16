/**
 * 单次结构化输出调用（结构化裁判的底座，spec 2026-06-14 砖 3）。
 *
 * 不复用 ApiAgentLoop —— 结构化调用不碰文件、不多轮、不用工具执行器：只发一次
 * completeStream，用 tool_choice 强制模型**必须**调用一个 schema 已定的工具，从
 * toolCalls 里读结构化结果，**绝不 grep 散文**。模型不守 tool_choice（拿不到工具调用 /
 * JSON 解析失败）= 抛错，由调用方决定降级（裁判场景 → ambiguous 停下报人，不退回 grep）。
 */

import type { MessageParam, ProviderAdapter } from "./providers/api/types";
import { resolveApiAdapter } from "./registry";

/** 强制调用的工具 schema（结构化结论的形状）。 */
export interface StructuredToolSpec {
  name: string;
  description: string;
  /** JSON Schema（type:object + properties + required）。 */
  input_schema: Record<string, unknown>;
}

export interface CompleteStructuredOpts {
  /** provider 引用名（裁判默认 anthropic）。强制走 API，不走 CLI 子进程。 */
  providerName: string;
  /** 模型；缺省回退 provider 的 default_model。 */
  model?: string;
  messages: MessageParam[];
  tool: StructuredToolSpec;
  /** 结构化结论一般很短，缺省 1024。 */
  maxTokens?: number;
  signal?: AbortSignal;
}

/**
 * 给定 adapter 跑一次强制结构化调用并解析工具入参（核心逻辑，可注入 mock adapter 测试）。
 */
export async function completeStructuredWith<T = Record<string, unknown>>(
  adapter: ProviderAdapter,
  opts: { model: string; messages: MessageParam[]; tool: StructuredToolSpec; maxTokens?: number; signal?: AbortSignal },
): Promise<T> {
  const res = await adapter.completeStream(opts.messages, {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 1024,
    tools: [opts.tool],
    tool_choice: { type: "force", name: opts.tool.name },
    disable_thinking: true, // 结构化判据不需思考；思考原生端点（Kimi）开思考时会拒绝强制 tool_choice
    signal: opts.signal,
    // 不传 onDelta：结构化调用不推流
  });

  const call = res.toolCalls?.find((c) => c.name === opts.tool.name) ?? res.toolCalls?.[0];
  if (!call || typeof call.input !== "object" || call.input === null) {
    throw new Error(
      `结构化调用未拿到工具调用（模型未遵守 tool_choice 强制「${opts.tool.name}」；stopReason=${res.stopReason}）`,
    );
  }
  // adapter 在 JSON 解析失败时把原始串塞进 { _raw }（见各 adapter content_block_stop 处理）
  if ("_raw" in call.input) {
    const raw = String((call.input as Record<string, unknown>)["_raw"]);
    throw new Error(`结构化调用的工具入参 JSON 解析失败：${raw.slice(0, 200)}`);
  }
  return call.input as T;
}

/**
 * 解析 provider → 适配器，跑一次强制结构化调用。
 */
export async function completeStructured<T = Record<string, unknown>>(
  opts: CompleteStructuredOpts,
): Promise<T> {
  const { adapter, defaultModel } = await resolveApiAdapter(opts.providerName);
  const model = opts.model ?? defaultModel;
  if (!model) {
    throw new Error(`结构化调用缺少 model（provider "${opts.providerName}" 也无 default_model）`);
  }
  return completeStructuredWith<T>(adapter, {
    model,
    messages: opts.messages,
    tool: opts.tool,
    maxTokens: opts.maxTokens,
    signal: opts.signal,
  });
}
