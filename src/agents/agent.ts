import type { BaseProvider } from "./providers/base";
import type { AgentConfig, AgentResult, RunOptions, ChatOptions, ChatResult, AgentMode } from "./types";
import type { ApiAgentLoop } from "./providers/api/loop";
import { UnsupportedInApiModeError } from "./providers/api/tools";
import { getTaskContext } from "../core/task-context";
import { getTaskAgentHome } from "../core/sandbox";
import { appendAgentCall } from "../core/task-logs";
import {
  recordProviderSuccess,
  recordProviderFailure,
} from "../core/provider-health";

export class Agent {
  /** API 模式下的 loop 实例（仅 mode=api 时有值） */
  private apiLoop?: ApiAgentLoop;
  /** API 模式惰性初始化工厂（由 registry.createAgent 注入，返回 ApiAgentLoop 实例） */
  private apiLoopFactory?: (sandboxRoot: string) => Promise<ApiAgentLoop>;
  /** 防止并发重复初始化的锁 */
  private apiLoopInitPromise?: Promise<void>;

  constructor(
    readonly name: string,
    private provider: BaseProvider,
    readonly config: AgentConfig,
    /** 接入方式：cli 或 api */
    readonly mode: AgentMode = "cli",
  ) {}

  /**
   * 注入 API agent loop 工厂函数。
   * 由 registry.createAgent 在 API 模式下设置，Agent.run() 首次调用时触发。
   * 工厂返回 ApiAgentLoop 实例，Agent 内部自行持有——不再暴露 setter。
   * @internal
   */
  setApiLoopFactory(factory: (sandboxRoot: string) => Promise<ApiAgentLoop>): void {
    this.apiLoopFactory = factory;
  }

  /**
   * 确保 API 模式下 apiLoop 已初始化。
   * 使用 Promise 锁防止并发重复初始化（M2）。
   */
  private async ensureApiLoop(): Promise<void> {
    if (this.apiLoop) return;

    if (!this.apiLoopFactory) {
      throw new Error(
        "API 模式 Agent 缺少初始化工厂函数。这通常意味着 Agent 不是通过 registry.createAgent() 创建的。"
      );
    }

    // 从 task context 获取 sandboxRoot
    const ctx = getTaskContext();
    if (!ctx?.sandboxDir) {
      throw new Error(
        "API 模式 Agent 需要 task context 中的 sandboxDir。请确保在 runWithTaskContext 内调用 agent.run()。"
      );
    }

    // Promise 锁：防止并发 phase 使用同一缓存 Agent 时重复初始化。
    // 失败后清除锁，允许后续重试（如 API key 已通过 key set 补录）。
    const sandboxDir = ctx.sandboxDir;
    if (!this.apiLoopInitPromise) {
      this.apiLoopInitPromise = (async () => {
        this.apiLoop = await this.apiLoopFactory!(sandboxDir);
      })().catch((e: unknown) => {
        // 工厂失败（key 未配置、解密失败等）→ 清除锁，允许下次重试
        this.apiLoopInitPromise = undefined;
        throw e;
      });
    }
    await this.apiLoopInitPromise;

    if (!this.apiLoop) {
      throw new Error("API agent loop 工厂函数完成但未返回有效实例。");
    }
  }

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
      if (this.mode === "api") {
        // API 模式：惰性初始化 apiLoop 后执行
        await this.ensureApiLoop();
        result = await this.apiLoop!.run(prompt, runOptions);
      } else {
        result = await this.provider.run(prompt, runOptions);
      }
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
   *
   * API 模式下抛出 UnsupportedInApiModeError（当前版本不支持 API 对话）。
   */
  async chat(message: string, options?: ChatOptions): Promise<ChatResult> {
    try {
      // API 模式：chat() 直接抛出不支持异常（不需要初始化 apiLoop）
      if (this.mode === "api") {
        // 如果 apiLoop 已初始化，走它的 chat（会抛 UnsupportedInApiModeError）
        if (this.apiLoop) {
          return await this.apiLoop.chat(message, options);
        }
        // 未初始化时直接抛，避免因 chat 不走 task context 而无法获取 sandboxDir
        throw new UnsupportedInApiModeError("chat");
      }
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
