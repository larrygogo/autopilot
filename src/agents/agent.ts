import type { BaseProvider } from "./providers/base";
import type { AgentConfig, AgentResult, RunOptions, ChatOptions, ChatResult } from "./types";
import { getTaskContext } from "../core/task-context";
import { getTaskAgentHome } from "../core/sandbox";
import { appendAgentCall } from "../core/task-logs";
import {
  recordProviderSuccess,
  recordProviderFailure,
} from "../core/provider-health";

export class Agent {
  constructor(
    readonly name: string,
    private provider: BaseProvider,
    readonly config: AgentConfig
  ) {}

  async run(prompt: string, options?: RunOptions): Promise<AgentResult> {
    const ctx = getTaskContext();  // 来自 runner 的 AsyncLocalStorage
    // L0 环境隔离：task 执行中的 agent 子进程改用沙箱内独立 AUTOPILOT_HOME，防 agent 跑
    // autopilot 命令污染用户真实 daemon/DB（沙箱此前只隔离代码、运行时未隔离）。
    // signal：显式传入优先，否则用 task-context 注入的 per-task 取消令牌（CONC-09）。
    // 注入点放在 Agent.run 而非各 phaseFn —— 所有走 agent.run 的 phase（含 prompt-runner 零代码模式）
    // 都自动获得可中断能力，无需逐个 phaseFn 改造。
    const runOptions: RunOptions | undefined = ctx
      ? { ...options, signal: options?.signal ?? ctx.signal, env: { ...options?.env, AUTOPILOT_HOME: getTaskAgentHome(ctx.taskId) } }
      : options;
    const started = Date.now();
    let result: AgentResult | undefined;
    let error: string | undefined;
    try {
      result = await this.provider.run(prompt, runOptions);
      recordProviderSuccess(this.config.provider ?? "unknown");
      return result;
    } catch (e: unknown) {
      error = e instanceof Error ? (e.stack ?? e.message) : String(e);
      recordProviderFailure(
        this.config.provider ?? "unknown",
        e instanceof Error ? e.message : String(e),
      );
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
    try {
      const result = await this.provider.chat(message, options);
      recordProviderSuccess(this.config.provider ?? "unknown");
      return result;
    } catch (e: unknown) {
      recordProviderFailure(
        this.config.provider ?? "unknown",
        e instanceof Error ? e.message : String(e),
      );
      throw e;
    }
  }

  async close(): Promise<void> {
    return this.provider.close();
  }
}
