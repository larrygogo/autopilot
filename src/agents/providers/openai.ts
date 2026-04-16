import { BaseProvider } from "./base";
import type { AgentResult, RunOptions } from "../types";

export class OpenAIProvider extends BaseProvider {
  async run(prompt: string, options?: RunOptions): Promise<AgentResult> {
    let sdk: any;
    try {
      sdk = await import("@openai/codex");
    } catch {
      throw new Error(
        "未安装 @openai/codex，请先执行：bun add @openai/codex"
      );
    }

    const model = this.resolveModel(options, "o4-mini");
    const maxTurns = this.resolveMaxTurns(options, 10);
    const systemPrompt = this.resolveSystemPrompt(options);

    const runOptions: Record<string, unknown> = {
      model,
      max_turns: maxTurns,
      ...this.buildRunOptions(options),
    };
    if (systemPrompt) runOptions["system_prompt"] = systemPrompt;

    const result = await sdk.run(prompt, runOptions);

    return {
      text: result?.result ?? result?.text ?? String(result ?? ""),
      usage: result?.usage
        ? {
            input_tokens: result.usage.input_tokens ?? result.usage.prompt_tokens,
            output_tokens: result.usage.output_tokens ?? result.usage.completion_tokens,
            total_cost_usd: result.usage.total_cost_usd,
          }
        : undefined,
    };
  }

  async close(): Promise<void> {}
}
