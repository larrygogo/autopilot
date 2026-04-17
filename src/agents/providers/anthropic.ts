import { BaseProvider } from "./base";
import type { AgentResult, RunOptions, ChatOptions, ChatResult } from "../types";

export class AnthropicProvider extends BaseProvider {
  private sessionId?: string;

  async chat(message: string, options?: ChatOptions): Promise<ChatResult> {
    let sdk: any;
    try {
      sdk = await import("@anthropic-ai/claude-agent-sdk");
    } catch {
      throw new Error(
        "未安装 @anthropic-ai/claude-agent-sdk，请先执行：bun add @anthropic-ai/claude-agent-sdk"
      );
    }

    const model = options?.model ?? (this.config["model"] as string | undefined) ?? "claude-sonnet-4-6";
    // 复用 run 的 system prompt 合并逻辑
    const systemPrompt = this.resolveSystemPrompt(options as RunOptions | undefined);

    const queryOpts: Record<string, unknown> = { model };
    if (systemPrompt) queryOpts["systemPrompt"] = systemPrompt;
    if (options?.cwd) queryOpts["cwd"] = options.cwd;
    if (options?.providerSessionId) queryOpts["resume"] = options.providerSessionId;
    const permissionMode = (this.config["permission_mode"] as string | undefined) ?? "auto";
    queryOpts["permissionMode"] = permissionMode;

    let abort: AbortController | undefined;
    if (options?.signal) {
      abort = new AbortController();
      options.signal.addEventListener("abort", () => abort?.abort());
      queryOpts["abortController"] = abort;
    }

    const q = sdk.query({ prompt: message, options: queryOpts });

    let text = "";
    let sessionIdOut: string | undefined;
    let usage: ChatResult["usage"];

    for await (const msg of q) {
      if (msg?.type === "result" && msg.subtype === "success") {
        text = msg.result ?? "";
        sessionIdOut = msg.session_id;
        if (msg.usage || typeof msg.total_cost_usd === "number") {
          usage = {
            input_tokens: msg.usage?.input_tokens,
            output_tokens: msg.usage?.output_tokens,
            total_cost_usd: msg.total_cost_usd,
          };
        }
      } else if (msg?.type === "result" && msg.subtype === "error_max_turns") {
        throw new Error(`对话达到 max_turns 上限（${msg.num_turns} 轮）`);
      }
    }

    return { text, providerSessionId: sessionIdOut, usage };
  }

  async run(prompt: string, options?: RunOptions): Promise<AgentResult> {
    let sdk: any;
    try {
      sdk = await import("@anthropic-ai/claude-agent-sdk");
    } catch {
      throw new Error(
        "未安装 @anthropic-ai/claude-agent-sdk，请先执行：bun add @anthropic-ai/claude-agent-sdk"
      );
    }

    const model = this.resolveModel(options, "claude-sonnet-4-6");
    const maxTurns = this.resolveMaxTurns(options, 10);
    const permissionMode = (this.config["permission_mode"] as string | undefined) ?? "auto";
    const systemPrompt = this.resolveSystemPrompt(options);

    const runOptions: Record<string, unknown> = {
      model,
      max_turns: maxTurns,
      permission_mode: permissionMode,
      ...this.buildRunOptions(options),
    };
    if (systemPrompt) runOptions["system_prompt"] = systemPrompt;

    if (this.sessionId) {
      runOptions["session_id"] = this.sessionId;
    }

    const result = await sdk.run(prompt, runOptions);

    if (result?.session_id) {
      this.sessionId = result.session_id;
    }

    return {
      text: result?.result ?? result?.text ?? String(result ?? ""),
      usage: result?.usage
        ? {
            input_tokens: result.usage.input_tokens,
            output_tokens: result.usage.output_tokens,
            total_cost_usd: result.usage.total_cost_usd,
          }
        : undefined,
    };
  }

  async close(): Promise<void> {
    this.sessionId = undefined;
  }
}
