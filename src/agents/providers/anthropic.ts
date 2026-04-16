import { BaseProvider } from "./base";
import type { AgentResult, RunOptions } from "../types";

export class AnthropicProvider extends BaseProvider {
  private sessionId?: string;

  async run(prompt: string, options?: RunOptions): Promise<AgentResult> {
    let sdk: any;
    try {
      sdk = await import("@anthropic-ai/claude-agent-sdk");
    } catch {
      throw new Error(
        "未安装 @anthropic-ai/claude-agent-sdk，请先执行：bun add @anthropic-ai/claude-agent-sdk"
      );
    }

    const model = (this.config["model"] as string | undefined) ?? "claude-sonnet-4-6";
    const maxTurns = (this.config["max_turns"] as number | undefined) ?? 10;
    const permissionMode = (this.config["permission_mode"] as string | undefined) ?? "auto";

    const runOptions: Record<string, unknown> = {
      model,
      max_turns: maxTurns,
      permission_mode: permissionMode,
      ...this.buildRunOptions(options),
    };

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
