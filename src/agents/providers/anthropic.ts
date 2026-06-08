import { existsSync } from "fs";
import { join } from "path";
import { BaseProvider } from "./base";
import type { AgentResult, RunOptions, ChatOptions, ChatResult } from "../types";
import { createLogger } from "../../core/logger";
import { AUTOPILOT_HOME } from "../../index";

const agentLog = createLogger("agent.anthropic");

/**
 * Anthropic provider：通过 `Bun.spawn` 直接调用本地 `claude` 二进制（claude code CLI），
 * 不再依赖 `@anthropic-ai/claude-agent-sdk`。
 *
 * 协议：
 *   stdin  ← prompt 文本（一次性写入并关闭）
 *   stdout → `--output-format stream-json` 的 NDJSON 事件流
 *   stderr → 错误/调试信息（仅在非 0 退出时使用）
 *
 * 现已知事件类型（已在本机 claude 2.1.141 实测）：
 *   - system.subtype = hook_started / hook_response / init    噪声，跳过
 *   - assistant     助手消息（content 块数组：text / tool_use）
 *   - user          工具结果回包（content 块：tool_result）
 *   - rate_limit_event                                       速率信息，跳过
 *   - stream_event  (--include-partial-messages 时)          partial delta
 *   - result.subtype = success / error_max_turns             终态
 *
 * MCP 工具接入：daemon 自带 HTTP MCP 路由（/mcp），通过 `--mcp-config` 传入
 * 临时 config 文件让 claude CLI 以子进程形式访问 autopilot 工具集。
 */

// ──────────────────────────────────────────────
// NDJSON 解析 + 消息桥接
// ──────────────────────────────────────────────

/** 把 ReadableStream<Uint8Array> 按行解析为 NDJSON 异步迭代器。 */
async function* parseNdjsonStream(stream: ReadableStream<Uint8Array>): AsyncIterable<unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          yield JSON.parse(line);
        } catch {
          // 非 JSON 行（理论上不会出现；兜底丢弃）
        }
      }
    }
    const tail = buf.trim();
    if (tail) {
      try { yield JSON.parse(tail); } catch { /* ignore */ }
    }
  } finally {
    reader.releaseLock();
  }
}

/** 把 CLI 流出的消息精简为一行人类可读摘要写到 logger（实时日志/阶段日志可见）。 */
function bridgeCliMessage(msg: unknown): void {
  if (!msg || typeof msg !== "object") return;
  const m = msg as Record<string, unknown>;
  if (m.type === "assistant") {
    const message = m.message as { content?: unknown[] } | undefined;
    const content = message?.content ?? [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        const txt = b.text.replace(/\s+/g, " ").trim();
        if (txt) agentLog.info("assistant: %s", txt.length > 240 ? txt.slice(0, 240) + "…" : txt);
      } else if (b.type === "tool_use") {
        const name = (b.name as string | undefined) ?? "?";
        const summary = summarizeToolInput(b.input);
        agentLog.info("tool: %s%s", name, summary ? " " + summary : "");
      }
    }
  } else if (m.type === "user") {
    const message = m.message as { content?: unknown[] } | undefined;
    const content = message?.content ?? [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "tool_result") {
        const c = b.content;
        const out =
          typeof c === "string"
            ? c
            : Array.isArray(c)
              ? c.map((x: unknown) => {
                  const xx = x as { text?: unknown } | null;
                  return typeof xx?.text === "string" ? xx.text : "";
                }).join("")
              : "";
        const trimmed = out.replace(/\s+/g, " ").trim();
        if (trimmed) agentLog.info("tool_result: %s", trimmed.length > 200 ? trimmed.slice(0, 200) + "…" : trimmed);
      }
    }
  }
}

function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  for (const key of ["file_path", "path", "pattern", "command", "url"]) {
    const v = obj[key];
    if (typeof v === "string") return `(${key}=${v.length > 80 ? v.slice(0, 80) + "…" : v})`;
  }
  return "";
}

// ──────────────────────────────────────────────
// CLI argv 构建 + 子进程封装
// ──────────────────────────────────────────────

interface BuildArgvParams {
  model: string;
  permissionMode: string;
  systemPrompt?: string;
  resumeSessionId?: string;
  includePartialMessages?: boolean;
  /** 启用 autopilot MCP（daemon 写好的 mcp-config.json） */
  mcpConfigPath?: string;
  /** 禁用 Claude 内建工具集（仅留 MCP 工具，配合 enableTools=true 用） */
  disableBuiltinTools?: boolean;
  /** 显式 allow 列表（空 → 不传该 flag） */
  allowedTools?: string[];
  /** 显式 disallow 列表 */
  disallowedTools?: string[];
}

function buildClaudeArgv(p: BuildArgvParams): string[] {
  const argv = [
    "claude",
    "-p",
    "--output-format", "stream-json",
    // stream-json 必须配合 --verbose 才会输出完整事件流
    "--verbose",
    "--model", p.model,
    "--permission-mode", p.permissionMode,
  ];
  if (p.systemPrompt) {
    argv.push("--system-prompt", p.systemPrompt);
  }
  if (p.resumeSessionId) {
    argv.push("--resume", p.resumeSessionId);
  }
  if (p.includePartialMessages) {
    argv.push("--include-partial-messages");
  }
  if (p.mcpConfigPath) {
    // --strict-mcp-config：只用此文件里的 MCP 服务器，忽略全局/项目级 mcp 配置，
    // 避免用户其他 MCP 配置污染 autopilot 子进程
    argv.push("--mcp-config", p.mcpConfigPath, "--strict-mcp-config");
  }
  if (p.disableBuiltinTools) {
    argv.push("--tools", "");
  }
  if (p.allowedTools && p.allowedTools.length > 0) {
    argv.push("--allowed-tools", ...p.allowedTools);
  }
  if (p.disallowedTools && p.disallowedTools.length > 0) {
    argv.push("--disallowed-tools", ...p.disallowedTools);
  }
  return argv;
}

/**
 * 找到 daemon 写好的 mcp-config.json。daemon 启动时写到固定路径
 * `AUTOPILOT_HOME/runtime/mcp-config.json`；agent 进程跑在同一 AUTOPILOT_HOME 下，
 * 文件不存在视为 daemon 没在跑（或未启用 MCP），调用方应降级到无工具行为。
 */
function resolveMcpConfigPath(): string | undefined {
  const path = join(AUTOPILOT_HOME, "runtime", "mcp-config.json");
  return existsSync(path) ? path : undefined;
}

interface SpawnResult {
  stderr: string;
  exitCode: number;
  aborted: boolean;
}

/**
 * spawn claude 子进程并消费 stdout/stderr。
 *
 * 调用方在 onMessage 内逐条处理事件；onMessage 抛出的错误会被吞掉以保证流不中断，
 * 想中止用 signal/timeout（会向子进程发 SIGTERM）。
 */
async function spawnClaudeAndConsume(opts: {
  argv: string[];
  prompt: string;
  cwd?: string;
  signal?: AbortSignal;
  timeout?: number;
  env?: Record<string, string>;
  onMessage: (msg: unknown) => void;
}): Promise<SpawnResult> {
  const abort = new AbortController();
  let aborted = false;
  const markAborted = () => { aborted = true; abort.abort(); };
  if (opts.signal) {
    if (opts.signal.aborted) markAborted();
    else opts.signal.addEventListener("abort", markAborted);
  }
  const timer = opts.timeout ? setTimeout(markAborted, opts.timeout) : undefined;

  const proc = Bun.spawn(opts.argv, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
  });

  const killOnAbort = () => {
    try { proc.kill(); } catch { /* 已退出 */ }
  };
  // 如果在我们注册 listener 之前 abort 信号已经触发（opts.signal 进来就 aborted、
  // 或 timeout=0 类极端情况），addEventListener 不会重放历史事件 → 子进程会跑飞
  // 永远不被 kill。所以注册 listener 之前先同步检查一次。
  if (abort.signal.aborted) {
    killOnAbort();
  } else {
    abort.signal.addEventListener("abort", killOnAbort);
  }

  try {
    // 写入 prompt（子进程可能提前退出导致写入失败，吞掉异常即可）
    // Bun.spawn 的 stdin 在 "pipe" 模式下是 FileSink，不是 WritableStream
    try {
      proc.stdin.write(opts.prompt);
      await proc.stdin.end();
    } catch {
      /* stdin 写入失败：子进程提前死了，下面读 stderr/exit 会给出真实原因 */
    }

    // 并发：消费 stdout NDJSON，同时收集 stderr
    const stderrPromise = new Response(proc.stderr).text();
    for await (const msg of parseNdjsonStream(proc.stdout)) {
      try {
        opts.onMessage(msg);
      } catch (e: unknown) {
        agentLog.error("onMessage 回调抛错（已吞）: %s", e instanceof Error ? e.message : String(e));
      }
    }
    const stderr = await stderrPromise;
    const exitCode = await proc.exited;
    return { stderr, exitCode, aborted };
  } finally {
    abort.signal.removeEventListener("abort", killOnAbort);
    if (opts.signal) opts.signal.removeEventListener("abort", markAborted);
    if (timer) clearTimeout(timer);
  }
}

// ──────────────────────────────────────────────
// Provider 实现
// ──────────────────────────────────────────────

export class AnthropicProvider extends BaseProvider {
  private sessionId?: string;

  async chat(message: string, options?: ChatOptions): Promise<ChatResult> {
    const model = options?.model ?? (this.config["model"] as string | undefined) ?? "claude-sonnet-4-6";
    const permissionMode = (this.config["permission_mode"] as string | undefined) ?? "auto";
    const systemPrompt = this.resolveSystemPrompt(options as RunOptions | undefined);

    // enableTools=true 时启用 autopilot MCP 工具集（list_tasks / start_task / 等等），
    // 并禁用 Claude Code 内建工具集（Read/Edit/Bash/...）以聚焦在 autopilot 域内。
    let mcpConfigPath: string | undefined;
    let disableBuiltinTools = false;
    let allowedTools: string[] | undefined;
    let appendedSystem: string | undefined;
    if (options?.enableTools) {
      mcpConfigPath = resolveMcpConfigPath();
      if (!mcpConfigPath) {
        agentLog.warn("chat enableTools=true 但 mcp-config.json 不存在（daemon 未在跑？），降级为无工具运行");
      } else {
        disableBuiltinTools = true;
        // 通配 mcp__autopilot__* — claude CLI 支持 prefix 风格的 allowedTools
        allowedTools = ["mcp__autopilot__*"];
        appendedSystem = [
          "你已接入 autopilot 内建工具集（mcp__autopilot__*），可以：",
          "- 只读：list_tasks / get_task / get_task_logs / list_workflows / get_workflow / list_sessions / get_session / get_daemon_status",
          "- 执行：start_task（启动任务）/ cancel_task（取消任务）",
          "",
          "调用准则：",
          "1. 用户问有哪些任务/工作流之类的问题时，直接用对应 list 工具拿真实数据，不要编造",
          "2. 执行操作前先用 list/get 工具确认当前状态",
          "3. 操作完成后简短汇报：做了什么 + 影响了哪些资源",
        ].join("\n");
      }
    }
    if (options?.onToolUse) {
      // onToolUse 当前未实装：assistant.content[].tool_use 事件可以解析转发，
      // 但需要工具调用生命周期 start/end 配对，留作后续增强。
      agentLog.warn("chat onToolUse 回调暂未接入");
    }

    const argv = buildClaudeArgv({
      model,
      permissionMode,
      systemPrompt: appendedSystem
        ? (systemPrompt ? `${systemPrompt}\n\n${appendedSystem}` : appendedSystem)
        : systemPrompt,
      resumeSessionId: options?.providerSessionId,
      includePartialMessages: !!options?.onDelta,
      mcpConfigPath,
      disableBuiltinTools,
      allowedTools,
    });

    let text = "";
    let sessionIdOut: string | undefined;
    let usage: ChatResult["usage"];
    let maxTurnsError: Error | undefined;

    const { stderr, exitCode, aborted } = await spawnClaudeAndConsume({
      argv,
      prompt: message,
      cwd: options?.cwd,
      signal: options?.signal,
      timeout: options?.timeout,
      onMessage: (msg) => {
        if (!msg || typeof msg !== "object") return;
        const m = msg as Record<string, unknown>;
        if (m.type === "system") return; // 过滤 hook 噪声 + init 事件
        if (m.type === "stream_event" && options?.onDelta) {
          const ev = (m as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event;
          if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
            try { options.onDelta(ev.delta.text); } catch { /* 回调异常不中断流 */ }
          }
          return;
        }
        if (m.type === "result") {
          if (m.subtype === "success") {
            text = (m.result as string | undefined) ?? "";
            sessionIdOut = m.session_id as string | undefined;
            const u = m.usage as { input_tokens?: number; output_tokens?: number } | undefined;
            const cost = m.total_cost_usd as number | undefined;
            if (u || typeof cost === "number") {
              usage = {
                input_tokens: u?.input_tokens,
                output_tokens: u?.output_tokens,
                total_cost_usd: cost,
              };
            }
          } else if (m.subtype === "error_max_turns") {
            maxTurnsError = new Error(`对话达到 max_turns 上限（${m.num_turns} 轮）`);
          }
        }
      },
    });

    if (maxTurnsError) throw maxTurnsError;
    if (aborted && !text) throw new Error("claude CLI 被取消或超时");
    if (exitCode !== 0 && !text) {
      throw new Error(`claude CLI 退出码 ${exitCode}: ${stderr.slice(0, 500)}`);
    }

    return { text, providerSessionId: sessionIdOut, usage };
  }

  async run(prompt: string, options?: RunOptions): Promise<AgentResult> {
    const model = this.resolveModel(options, "claude-sonnet-4-6");
    const permissionMode = (this.config["permission_mode"] as string | undefined) ?? "auto";
    const systemPrompt = this.resolveSystemPrompt(options);
    // NOTE: max_turns 在 claude CLI 上没有直接对应的 flag。Step 1 暂不强制；
    // 上游对超时控制依然走 options.timeout（spawnClaudeAndConsume 会 kill 子进程）。
    // 若后续确需硬性 turn 限制，可走 `--settings <json>` 传 maxTurns。

    // 工作流阶段 agent 需要 ask_user 等 autopilot 工具，同时保留 Claude 内建工具
    // （Read/Edit/Bash 等通常是阶段函数干活必需的）。
    // 禁用 Claude 内建 AskUserQuestion：autopilot 用 MCP ask_user 接管人机交互通道。
    const mcpConfigPath = resolveMcpConfigPath();
    const allowedTools = mcpConfigPath ? ["mcp__autopilot__*"] : undefined;
    const disallowedTools = mcpConfigPath ? ["AskUserQuestion"] : undefined;

    const argv = buildClaudeArgv({
      model,
      permissionMode,
      systemPrompt,
      resumeSessionId: this.sessionId,
      mcpConfigPath,
      allowedTools,
      disallowedTools,
    });

    let text = "";
    let usage: AgentResult["usage"];
    let sessionIdOut: string | undefined;
    let maxTurnsError: Error | undefined;

    const { stderr, exitCode, aborted } = await spawnClaudeAndConsume({
      argv,
      prompt,
      cwd: options?.cwd,
      signal: options?.signal,
      timeout: options?.timeout,
      env: options?.env,
      onMessage: (msg) => {
        if (!msg || typeof msg !== "object") return;
        const m = msg as Record<string, unknown>;
        if (m.type === "system") return;
        bridgeCliMessage(msg);
        if (m.type === "result") {
          if (m.subtype === "success") {
            text = (m.result as string | undefined) ?? "";
            sessionIdOut = m.session_id as string | undefined;
            const u = m.usage as { input_tokens?: number; output_tokens?: number } | undefined;
            const cost = m.total_cost_usd as number | undefined;
            if (u || typeof cost === "number") {
              usage = {
                input_tokens: u?.input_tokens,
                output_tokens: u?.output_tokens,
                total_cost_usd: cost,
              };
            }
          } else if (m.subtype === "error_max_turns") {
            maxTurnsError = new Error(`对话达到 max_turns 上限（${m.num_turns} 轮）`);
          }
        }
      },
    });

    if (maxTurnsError) throw maxTurnsError;
    if (aborted && !text) throw new Error("claude CLI 被取消或超时");
    if (exitCode !== 0 && !text) {
      throw new Error(`claude CLI 退出码 ${exitCode}: ${stderr.slice(0, 500)}`);
    }

    if (sessionIdOut) {
      this.sessionId = sessionIdOut;
    }

    return { text, usage };
  }

  async close(): Promise<void> {
    this.sessionId = undefined;
  }
}
