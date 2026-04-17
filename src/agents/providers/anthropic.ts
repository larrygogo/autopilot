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
    // 打开 token 级流式事件；onDelta 未提供也无副作用
    if (options?.onDelta) {
      queryOpts["includePartialMessages"] = true;
    }
    // 注入 autopilot tools（用 SDK MCP server 同进程承载）
    if (options?.enableTools) {
      const { buildAutopilotTools, TOOL_NAMES } = await import("../tools");
      const tools = await buildAutopilotTools();
      queryOpts["mcpServers"] = {
        autopilot: sdk.createSdkMcpServer({
          name: "autopilot",
          version: "1.0.0",
          tools,
        }),
      };
      // 默认关闭 Claude Code 内建工具，只暴露 autopilot 工具
      queryOpts["tools"] = [];
      // 把 autopilot tool 加进 allowedTools，省去交互式 permission 询问
      queryOpts["allowedTools"] = TOOL_NAMES.map((n) => `mcp__autopilot__${n}`);
      // 追加工具使用指引到 system prompt
      const toolsHint = [
        "你已接入 autopilot 内建工具集，可以：",
        "- 只读：list_tasks / get_task / get_task_logs / list_workflows / get_workflow / list_sessions / get_session / get_daemon_status",
        "- 执行：start_task（启动任务）/ cancel_task（取消任务）",
        "",
        "调用准则：",
        "1. 用户问有哪些任务/工作流之类的问题时，直接用对应 list 工具拿真实数据，不要编造",
        "2. 执行操作前先用 list/get 工具确认当前状态",
        "3. 操作完成后简短汇报：做了什么 + 影响了哪些资源",
      ].join("\n");
      queryOpts["systemPrompt"] = systemPrompt
        ? `${systemPrompt}\n\n${toolsHint}`
        : toolsHint;
    }

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
      if (msg?.type === "stream_event" && options?.onDelta) {
        // 形如 { event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '...' } } }
        const ev = (msg as { event?: unknown }).event as
          | { type?: string; delta?: { type?: string; text?: string } }
          | undefined;
        if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
          try { options.onDelta(ev.delta.text); } catch { /* 回调异常不中断流 */ }
        }
      } else if (msg?.type === "result" && msg.subtype === "success") {
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
