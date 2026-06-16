/**
 * ApiAgentLoop — API 模式下的多轮 tool-use 循环。
 *
 * 核心流程：
 *   1. 构建消息（system + user prompt）
 *   2. 流式调用 provider adapter
 *   3. 收集 tool_calls → ToolExecutor 执行 → tool_result → 下一轮
 *   4. task_complete 工具调用时短路退出
 *   5. max_turns 或无 tool_call 时正常退出
 *
 * 包含：重试逻辑、上下文窗口管理、usage 累计、流式输出推送。
 */

import type { AgentResult, RunOptions, ChatOptions, ChatResult } from "../../types";
import type { ProviderAdapter, AdapterOptions, MessageParam, ContentBlock, ToolResultContent, ToolUseBlock } from "./types";
import { ToolExecutor, UnsupportedInApiModeError } from "./tools";
import { log } from "../../../core/logger";
import { ApiError } from "./anthropic";

// ── 上下文窗口管理 ──

const CONTEXT_LIMITS: Record<string, number> = {
  "claude-opus-4": 160_000,
  "claude-opus-4-6": 160_000,
  "claude-sonnet-4": 160_000,
  "claude-sonnet-4-6": 160_000,
  "claude-haiku-4": 160_000,
  "gpt-4o": 100_000,
  "gpt-4o-mini": 100_000,
  "gpt-4.1": 1_000_000,
  "gpt-4.1-mini": 1_000_000,
  "gemini-2.5-pro": 800_000,
  "gemini-2.5-flash": 800_000,
  "deepseek-chat": 56_000,
};
const DEFAULT_CONTEXT_LIMIT = 60_000;

/**
 * 粗估 token 数（1 token ≈ 4 字符）。
 *
 * 需要统计：
 *   - 纯文本消息内容
 *   - ContentBlock.text（assistant 文本输出）
 *   - ToolResultContent.content（工具执行结果）
 *   - ContentBlock.input（tool_use 参数，可能含大文件内容如 write_file）
 *
 * tool_use.input 可能承载整个文件内容（write_file 场景），不统计会导致
 * estimateTokens 严重偏低，致 trimMessagesToFitContext 裁剪循环空转，
 * 对 DeepSeek 等小上下文模型产生 context limit API 错误。
 */
function estimateTokens(messages: MessageParam[]): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      total += msg.content.length / 4;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content as unknown[]) {
        if (typeof block === "string") {
          total += block.length / 4;
        } else if (block && typeof block === "object") {
          const b = block as Record<string, unknown>;
          // ContentBlock.text（assistant 文本）
          if (typeof b.text === "string") {
            total += b.text.length / 4;
          }
          // ToolResultContent.content（工具输出）
          if (typeof b.content === "string") {
            total += b.content.length / 4;
          }
          // ContentBlock.input — tool_use 参数（write_file 等可能含大文件内容）
          if (b.input && typeof b.input === "object") {
            total += JSON.stringify(b.input).length / 4;
          }
        }
      }
    }
  }
  return Math.ceil(total);
}

export function trimMessagesToFitContext(
  messages: MessageParam[],
  model: string,
  currentInputTokens: number,
): MessageParam[] {
  const limit = (CONTEXT_LIMITS[model] ?? DEFAULT_CONTEXT_LIMIT) * 0.8;
  if (currentInputTokens <= limit) return messages;

  // 保护前缀：system（若有）+ 紧随的首条 user（= 任务 prompt，丢了等于丢任务），永不裁。
  let prefixLen = 0;
  if (messages[prefixLen]?.role === "system") prefixLen++;
  if (messages[prefixLen]?.role === "user") prefixLen++;
  const prefix = messages.slice(0, prefixLen);
  const remaining = messages.slice(prefixLen);

  // 从最旧逐条丢弃。关键：每丢一条后，把因此变成 orphan 的 tool_result（其对应的
  // assistant tool_call 已被丢）一并清掉——否则 OpenAI 兼容端（kimi 等）会因 tool 消息
  // 的 tool_call_id 在前文 tool_calls 里找不到而报 400「tool_call_id is not found」。
  // 旧实现按固定 2 条成对 splice，被首条 user 错位后会把 tool_result 留成孤儿（实测
  // dev-kimi design 读大仓库致 input 超限触发裁剪 → 400 → 阶段误失败）。
  while (remaining.length > 0 && estimateTokens([...prefix, ...remaining]) > limit - 8_000) {
    remaining.shift();
    while (remaining.length > 0 && remaining[0]?.role === "tool_result") {
      remaining.shift();
    }
  }

  return [...prefix, ...remaining];
}

// ── 重试逻辑 ──

function isRetryableError(e: unknown): boolean {
  if (e instanceof ApiError) {
    return e.status === 429 || (e.status >= 500 && e.status < 600);
  }
  // 网络错误
  if (e instanceof TypeError && e.message.includes("fetch")) return true;
  return false;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("Task cancelled")); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("Task cancelled")); }, { once: true });
  });
}

async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  signal?: AbortSignal,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) throw new Error("Task cancelled");
    try {
      return await fn();
    } catch (e: unknown) {
      lastError = e;
      if (!isRetryableError(e) || attempt === maxAttempts) throw e;

      // 指数退避：1s → 2s → 4s，最大 30s
      const baseDelay = Math.min(1000 * 2 ** (attempt - 1), 30_000);
      // 加抖动（±20%）避免惊群
      const jitter = baseDelay * (0.8 + Math.random() * 0.4);
      log.warn("API 调用失败（尝试 %d/%d），%dms 后重试：%s", attempt, maxAttempts, Math.round(jitter),
        e instanceof Error ? e.message : String(e));
      await sleep(jitter, signal);
    }
  }
  throw lastError;
}

// ── ApiAgentLoop ──

export interface ApiAgentLoopOptions {
  adapter: ProviderAdapter;
  toolExecutor: ToolExecutor;
  model: string;
  systemPrompt?: string;
  maxTurns: number;
  /** 流式文本增量回调 */
  onStream?: (delta: string) => void;
}

export class ApiAgentLoop {
  private adapter: ProviderAdapter;
  private toolExecutor: ToolExecutor;
  private model: string;
  private systemPrompt?: string;
  private maxTurns: number;
  private onStream?: (delta: string) => void;

  constructor(options: ApiAgentLoopOptions) {
    this.adapter = options.adapter;
    this.toolExecutor = options.toolExecutor;
    this.model = options.model;
    this.systemPrompt = options.systemPrompt;
    this.maxTurns = options.maxTurns;
    this.onStream = options.onStream;
  }

  /**
   * 执行多轮 tool-use 循环。
   */
  async run(prompt: string, runOpts?: RunOptions): Promise<AgentResult> {
    const messages: MessageParam[] = [];
    const usage = { input_tokens: 0, output_tokens: 0, total_cost_usd: 0 };

    // 构建初始消息
    const systemPrompt = runOpts?.system_prompt ?? this.systemPrompt;
    const additionalSystem = runOpts?.additional_system;
    let finalSystem = systemPrompt;
    if (additionalSystem) {
      finalSystem = finalSystem ? `${finalSystem}\n\n${additionalSystem}` : additionalSystem;
    }

    if (finalSystem) {
      messages.push({ role: "system", content: finalSystem });
    }
    messages.push({ role: "user", content: prompt });

    const model = runOpts?.model ?? this.model;
    const maxTurns = runOpts?.max_turns ?? this.maxTurns;
    const tools = this.toolExecutor.getToolDefinitions();

    for (let turn = 0; turn < maxTurns; turn++) {
      if (runOpts?.signal?.aborted) throw new Error("Task cancelled");

      const adapterOptions: AdapterOptions = {
        model,
        tools,
        max_tokens: 8192,
        signal: runOpts?.signal,
      };

      // 流式调用 adapter
      const response = await withRetry(
        () => this.adapter.completeStream(messages, adapterOptions, this.onStream),
        3,
        runOpts?.signal,
      );

      // 本轮完整文本一次性记录（取代逐碎片 onStream 日志，避免几百条碎片行）
      // reasoningFallback=true 时 text 是推理内容回退，不记录（避免把长推理文写入运行日志）
      if (response.text && !response.reasoningFallback) {
        log.info("[API] 本轮输出：%s", response.text);
      }

      // 累计 usage
      usage.input_tokens += response.usage.input_tokens;
      usage.output_tokens += response.usage.output_tokens;

      // 上下文窗口管理
      const currentMessages = trimMessagesToFitContext(messages, model, response.usage.input_tokens);
      if (currentMessages.length < messages.length) {
        messages.splice(0, messages.length, ...currentMessages);
      }

      // 无工具调用 → 返回文本
      if (!response.toolCalls || response.toolCalls.length === 0) {
        return { text: response.text || "(无输出)", usage };
      }

      // 有工具调用 → 构建 assistant 消息（含 tool_use blocks）
      const assistantContent: ContentBlock[] = [];
      if (response.text) {
        assistantContent.push({ type: "text", text: response.text });
      }
      for (const tc of response.toolCalls) {
        assistantContent.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: tc.input,
        });
      }
      messages.push({ role: "assistant", content: assistantContent });

      // 检查是否有 task_complete 工具调用
      const completeCall = response.toolCalls.find((tc) => tc.name === "task_complete");
      if (completeCall) {
        return {
          text: (completeCall.input["summary"] as string) || response.text || "完成",
          usage,
        };
      }

      // 执行工具调用
      const toolResults: ToolResultContent[] = [];
      for (const tc of response.toolCalls) {
        log.info("[API] 工具调用：%s", tc.name);
        const result = await this.toolExecutor.execute({ name: tc.name, input: tc.input });
        toolResults.push({
          type: "tool_result",
          tool_use_id: tc.id,
          content: result.output,
          is_error: result.is_error,
          name: tc.name, // Google Gemini 要求 functionResponse.name 与 functionCall.name 匹配
        });
      }

      // 添加 tool_result 消息
      messages.push({ role: "tool_result", content: toolResults });
    }

    // 超出 max_turns，取最后一轮的文本输出
    const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
    const lastText = lastAssistant
      ? (Array.isArray(lastAssistant.content)
          ? lastAssistant.content.filter((b): b is ContentBlock => typeof b !== "string" && b.type === "text").map((b) => b.text).join("")
          : lastAssistant.content as string)
      : "(超出最大轮次)";

    return { text: lastText, usage };
  }

  /**
   * chat() 在 API 模式下不支持（当前版本）。
   */
  async chat(_message: string, _options?: ChatOptions): Promise<ChatResult> {
    throw new UnsupportedInApiModeError("chat");
  }
}
