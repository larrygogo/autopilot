import { BaseProvider } from "./base";
import type { AgentResult, RunOptions } from "../types";
import { createLogger } from "../../core/logger";

const agentLog = createLogger("agent.google");

/**
 * Google provider：依赖本地 `gemini` CLI（npm i -g @google/gemini-cli）。
 * `@google/gemini-cli-sdk` npm 包当前并不存在/不再发布，无可用 JS SDK 入口；
 * 与 anthropic provider 的 SDK 流式调用不同，这里通过 `gemini -p` 子进程
 * 非交互式执行 prompt 并读取 stdout。
 */
export class GoogleProvider extends BaseProvider {
  async run(prompt: string, options?: RunOptions): Promise<AgentResult> {
    const model = this.resolveModel(options, "gemini-2.5-pro");
    const systemPrompt = this.resolveSystemPrompt(options);

    // gemini CLI：-p 非交互式 prompt，-m 指定模型
    const argv: string[] = ["gemini", "-m", model, "--yolo"];
    // gemini 没有官方 system prompt 入参，把它前置拼到用户 prompt
    const finalPrompt = systemPrompt
      ? `${systemPrompt}\n\n---\n\n${prompt}`
      : prompt;
    argv.push("-p", finalPrompt);

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
        stdout: "pipe",
        stderr: "pipe",
        signal: abort.signal,
        cwd: options?.cwd,
      });
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      stdout = out;
      stderr = err;
      const code = await proc.exited;
      if (code !== 0) {
        throw new Error(`gemini 失败 (exit=${code}): ${stderr.slice(0, 500)}`);
      }
    } catch (e: unknown) {
      if (abort.signal.aborted) {
        throw new Error("gemini 被取消或超时");
      }
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }

    const text = stdout.trim();
    if (text) {
      const summary = text.replace(/\s+/g, " ").trim();
      agentLog.info("assistant: %s", summary.length > 240 ? summary.slice(0, 240) + "…" : summary);
    }
    return { text };
  }

  async close(): Promise<void> {}
}
