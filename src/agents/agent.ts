import type { BaseProvider } from "./providers/base";
import type { AgentConfig, AgentResult, RunOptions, ChatOptions, ChatResult } from "./types";
import { getTaskContext } from "../core/task-context";
import { appendAgentCall } from "../core/task-logs";

export class Agent {
  constructor(
    readonly name: string,
    private provider: BaseProvider,
    readonly config: AgentConfig
  ) {}

  async run(prompt: string, options?: RunOptions): Promise<AgentResult> {
    const ctx = getTaskContext();  // 来自 runner 的 AsyncLocalStorage
    const started = Date.now();
    let result: AgentResult | undefined;
    let error: string | undefined;
    try {
      result = await this.provider.run(prompt, options);
      return result;
    } catch (e: unknown) {
      error = e instanceof Error ? (e.stack ?? e.message) : String(e);
      throw e;
    } finally {
      if (ctx) {
        appendAgentCall(ctx.taskId, {
          phase: ctx.phase,
          agent: this.name,
          provider: this.config.provider,
          model: options?.model ?? this.config.model,
          prompt,
          system_prompt: options?.system_prompt,
          additional_system: options?.additional_system,
          elapsed_ms: Date.now() - started,
          result_text: result?.text,
          usage: result?.usage,
          error,
        });
      }
    }
  }

  /**
   * 多轮对话。不走 task context（对话不属于任务）、不写 agent-calls.jsonl。
   * Session 状态（历史、provider_session_id）由调用方维护。
   */
  async chat(message: string, options?: ChatOptions): Promise<ChatResult> {
    return this.provider.chat(message, options);
  }

  async close(): Promise<void> {
    return this.provider.close();
  }
}
