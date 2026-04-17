import type { AgentResult, RunOptions, ChatOptions, ChatResult } from "../types";

export abstract class BaseProvider {
  constructor(protected config: Record<string, unknown>) {}
  abstract run(prompt: string, options?: RunOptions): Promise<AgentResult>;
  abstract close(): Promise<void>;

  /**
   * 多轮对话。未实现的 provider 默认抛错。
   * 传入 options.providerSessionId 则续该 session，否则开新 session。
   */
  async chat(_message: string, _options?: ChatOptions): Promise<ChatResult> {
    throw new Error(`${this.constructor.name}.chat 未实现`);
  }

  protected buildRunOptions(options?: RunOptions): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    if (options?.cwd) result["cwd"] = options.cwd;
    if (options?.timeout !== undefined) result["timeout_ms"] = options.timeout;
    if (options?.signal) result["signal"] = options.signal;
    return result;
  }

  /** 取最终 model：RunOptions > config > 默认 */
  protected resolveModel(options: RunOptions | undefined, fallback: string): string {
    return options?.model ?? (this.config["model"] as string | undefined) ?? fallback;
  }

  /** 取最终 max_turns：RunOptions > config > 默认 */
  protected resolveMaxTurns(options: RunOptions | undefined, fallback: number): number {
    return options?.max_turns ?? (this.config["max_turns"] as number | undefined) ?? fallback;
  }

  /**
   * 取最终 system_prompt：
   *   base = RunOptions.system_prompt (替换) ?? config.system_prompt
   *   final = base + (RunOptions.additional_system 如存在则追加)
   * 都不提供时返回 undefined。
   */
  protected resolveSystemPrompt(options: RunOptions | undefined): string | undefined {
    const configured = this.config["system_prompt"] as string | undefined;
    const base = options?.system_prompt ?? configured;
    const additional = options?.additional_system;
    if (!additional) return base;
    if (!base) return additional;
    return `${base}\n\n${additional}`;
  }
}
