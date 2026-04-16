import { BaseProvider } from "./base";
import type { AgentResult, RunOptions } from "../types";

export class GoogleProvider extends BaseProvider {
  async run(prompt: string, options?: RunOptions): Promise<AgentResult> {
    let sdk: any;
    try {
      sdk = await import("@google/gemini-cli-sdk");
    } catch {
      throw new Error(
        "未安装 @google/gemini-cli-sdk，请先执行：bun add @google/gemini-cli-sdk"
      );
    }

    const model = (this.config["model"] as string | undefined) ?? "gemini-2.5-pro";
    const maxTurns = (this.config["max_turns"] as number | undefined) ?? 10;

    const runOptions: Record<string, unknown> = {
      model,
      max_turns: maxTurns,
      ...this.buildRunOptions(options),
    };

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
