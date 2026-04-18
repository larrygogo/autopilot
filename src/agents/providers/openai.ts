import { BaseProvider } from "./base";
import type { AgentResult, RunOptions } from "../types";
import { createLogger } from "../../core/logger";

const agentLog = createLogger("agent.openai");

/**
 * OpenAI provider：依赖本地 `codex` CLI（npm i -g @openai/codex）。
 * `@openai/codex` npm 包仅是 native 二进制 launcher，没有 JS SDK 入口；
 * 与 anthropic provider 的 SDK 流式调用不同，这里通过 `codex exec --json`
 * 子进程读取 JSONL 事件流（assistant_message / token_count 等）。
 */
export class OpenAIProvider extends BaseProvider {
  async run(prompt: string, options?: RunOptions): Promise<AgentResult> {
    const model = this.resolveModel(options, "o4-mini");
    const systemPrompt = this.resolveSystemPrompt(options);
    const sandbox = (this.config["sandbox"] as string | undefined) ?? "workspace-write";

    // codex exec：非交互式，--json 输出 JSONL 事件流
    const argv: string[] = ["codex", "exec", "--json", "--skip-git-repo-check"];
    argv.push("-m", model);
    argv.push("-s", sandbox);
    if (options?.cwd) argv.push("-C", options.cwd);
    // 把 system_prompt 作为 -c 配置覆盖（写到 instructions 字段，TOML 字符串）
    if (systemPrompt) {
      const escaped = systemPrompt.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      argv.push("-c", `instructions="${escaped}"`);
    }
    // prompt 走 stdin（避免命令行长度 / shell 转义问题）
    argv.push("-");

    // signal + timeout → AbortController
    const abort = new AbortController();
    if (options?.signal) {
      options.signal.addEventListener("abort", () => abort.abort());
    }
    const timer = options?.timeout
      ? setTimeout(() => abort.abort(), options.timeout)
      : undefined;

    let stdout = "";
    let stderr = "";
    try {
      const proc = Bun.spawn(argv, {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        signal: abort.signal,
        cwd: options?.cwd,
      });
      proc.stdin.write(prompt);
      proc.stdin.end();

      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      stdout = out;
      stderr = err;
      const code = await proc.exited;
      if (code !== 0) {
        throw new Error(`codex exec 失败 (exit=${code}): ${stderr.slice(0, 500)}`);
      }
    } catch (e: unknown) {
      if (abort.signal.aborted) {
        throw new Error("codex exec 被取消或超时");
      }
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }

    // 解析 JSONL：取最后一条 agent_message / assistant_message / item.completed 文本
    let text = "";
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let evt: any;
      try {
        evt = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const msg = evt?.msg ?? evt;
      const type = msg?.type;
      // assistant 文本：codex 事件可能叫 agent_message / assistant_message
      if (type === "agent_message" || type === "assistant_message") {
        const t =
          typeof msg.message === "string"
            ? msg.message
            : typeof msg.text === "string"
              ? msg.text
              : "";
        if (t) {
          text = t;
          agentLog.info(
            "assistant: %s",
            t.length > 240 ? t.slice(0, 240) + "…" : t.replace(/\s+/g, " ").trim()
          );
        }
      } else if (type === "item.completed" && msg?.item?.text) {
        // 新版本事件名兼容
        text = String(msg.item.text);
      } else if (type === "token_count" || type === "usage") {
        const u = msg.usage ?? msg;
        inputTokens = u.input_tokens ?? u.prompt_tokens ?? inputTokens;
        outputTokens = u.output_tokens ?? u.completion_tokens ?? outputTokens;
      }
    }

    // 兜底：JSONL 没解出文本就用整段 stdout
    if (!text) text = stdout.trim();

    return {
      text,
      usage:
        inputTokens !== undefined || outputTokens !== undefined
          ? { input_tokens: inputTokens, output_tokens: outputTokens }
          : undefined,
    };
  }

  async close(): Promise<void> {}
}
