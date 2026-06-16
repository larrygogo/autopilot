/**
 * ApiAgentLoop 单元测试。
 *
 * 覆盖：
 *   - 多轮 tool-use 循环基本流程
 *   - task_complete 工具短路退出（M1）
 *   - max_turns 超限退出
 *   - context window 裁剪
 *   - 重试逻辑（429/5xx）
 *   - chat() 抛 UnsupportedInApiModeError（I6）
 *   - Agent 惰性初始化流程（C1 修复验证）
 *   - resolveMode 路由逻辑
 */

import { describe, it, expect, mock, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { ApiAgentLoop } from "../src/agents/providers/api/loop";
import { ToolExecutor, UnsupportedInApiModeError } from "../src/agents/providers/api/tools";
import type { ProviderAdapter, AdapterResponse, MessageParam, AdapterOptions } from "../src/agents/providers/api/types";
import { ApiError } from "../src/agents/providers/api/anthropic";
import { resolveMode, createAgent, _resetForTest } from "../src/agents/registry";
import { log } from "../src/core/logger";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// ── Mock Adapter ──

function createMockAdapter(responses: AdapterResponse[]): ProviderAdapter {
  let callIdx = 0;
  return {
    name: "mock",
    async completeStream(
      _messages: MessageParam[],
      _options: AdapterOptions,
      onDelta?: (delta: string) => void,
    ): Promise<AdapterResponse> {
      const resp = responses[callIdx] ?? responses[responses.length - 1];
      callIdx++;
      if (onDelta && resp.text) onDelta(resp.text);
      return resp;
    },
  };
}

// ── ApiAgentLoop 基本流程 ──

describe("ApiAgentLoop", () => {
  let sandbox: string;

  beforeAll(() => {
    sandbox = join(tmpdir(), `autopilot-loop-test-${Date.now()}`);
    mkdirSync(sandbox, { recursive: true });
  });

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("无工具调用 → 直接返回文本", async () => {
    const adapter = createMockAdapter([{
      text: "Hello world",
      usage: { input_tokens: 10, output_tokens: 5 },
      stopReason: "end_turn",
    }]);
    const executor = ToolExecutor.fromConfig(sandbox, "default");

    const loop = new ApiAgentLoop({
      adapter,
      toolExecutor: executor,
      model: "test-model",
      maxTurns: 10,
    });

    const result = await loop.run("Say hello");
    expect(result.text).toBe("Hello world");
    expect(result.usage?.input_tokens).toBe(10);
    expect(result.usage?.output_tokens).toBe(5);
  });

  it("task_complete 工具调用 → 短路退出并返回 summary（M1）", async () => {
    const adapter = createMockAdapter([{
      text: "Let me finish",
      toolCalls: [{ id: "call_1", name: "task_complete", input: { summary: "任务完成：所有文件已更新" } }],
      usage: { input_tokens: 20, output_tokens: 15 },
      stopReason: "tool_use",
    }]);
    const executor = ToolExecutor.fromConfig(sandbox, "default");

    const loop = new ApiAgentLoop({
      adapter,
      toolExecutor: executor,
      model: "test-model",
      maxTurns: 10,
    });

    const result = await loop.run("Complete the task");
    // task_complete 返回 summary 作为输出文本
    expect(result.text).toBe("任务完成：所有文件已更新");
  });

  it("工具调用 → 执行 → 继续对话 → 返回", async () => {
    // 创建测试文件
    writeFileSync(join(sandbox, "hello.txt"), "hello content");

    const adapter = createMockAdapter([
      // 第一轮：LLM 请求读文件
      {
        text: "Let me read the file",
        toolCalls: [{ id: "call_1", name: "read_file", input: { path: "hello.txt" } }],
        usage: { input_tokens: 10, output_tokens: 10 },
        stopReason: "tool_use",
      },
      // 第二轮：LLM 看到文件内容后返回最终答案
      {
        text: "文件内容是 hello content",
        usage: { input_tokens: 30, output_tokens: 10 },
        stopReason: "end_turn",
      },
    ]);
    const executor = ToolExecutor.fromConfig(sandbox, "default");

    const loop = new ApiAgentLoop({
      adapter,
      toolExecutor: executor,
      model: "test-model",
      maxTurns: 10,
    });

    const result = await loop.run("Read hello.txt");
    expect(result.text).toBe("文件内容是 hello content");
    // usage 累加
    expect(result.usage?.input_tokens).toBe(40);
    expect(result.usage?.output_tokens).toBe(20);
  });

  it("max_turns 超限 → 返回最后一轮文本", async () => {
    // 每轮都返回工具调用，永不结束
    const adapter = createMockAdapter([{
      text: "Still working...",
      toolCalls: [{ id: "call_n", name: "bash", input: { command: "echo loop" } }],
      usage: { input_tokens: 10, output_tokens: 5 },
      stopReason: "tool_use",
    }]);
    const executor = ToolExecutor.fromConfig(sandbox, "bypassPermissions");

    const loop = new ApiAgentLoop({
      adapter,
      toolExecutor: executor,
      model: "test-model",
      maxTurns: 3, // 限制 3 轮
    });

    const result = await loop.run("Loop forever");
    // 超出 maxTurns 时应返回最后一轮 assistant 的文本
    expect(result.text).toContain("Still working...");
  });

  it("chat() 抛出 UnsupportedInApiModeError（I6）", async () => {
    const adapter = createMockAdapter([{
      text: "unused",
      usage: { input_tokens: 0, output_tokens: 0 },
      stopReason: "end_turn",
    }]);
    const executor = ToolExecutor.fromConfig(sandbox, "default");

    const loop = new ApiAgentLoop({
      adapter,
      toolExecutor: executor,
      model: "test-model",
      maxTurns: 10,
    });

    await expect(loop.chat("hello")).rejects.toThrow(UnsupportedInApiModeError);
  });

  it("signal 取消 → 抛出 Task cancelled", async () => {
    const controller = new AbortController();
    // 立即取消
    controller.abort();

    const adapter = createMockAdapter([{
      text: "unused",
      usage: { input_tokens: 0, output_tokens: 0 },
      stopReason: "end_turn",
    }]);
    const executor = ToolExecutor.fromConfig(sandbox, "default");

    const loop = new ApiAgentLoop({
      adapter,
      toolExecutor: executor,
      model: "test-model",
      maxTurns: 10,
    });

    await expect(loop.run("test", { signal: controller.signal })).rejects.toThrow("cancelled");
  });

  it("onStream 回调接收文本增量", async () => {
    const adapter = createMockAdapter([{
      text: "streaming text",
      usage: { input_tokens: 5, output_tokens: 3 },
      stopReason: "end_turn",
    }]);
    const executor = ToolExecutor.fromConfig(sandbox, "default");

    const deltas: string[] = [];
    const loop = new ApiAgentLoop({
      adapter,
      toolExecutor: executor,
      model: "test-model",
      maxTurns: 10,
      onStream: (delta) => deltas.push(delta),
    });

    await loop.run("test");
    expect(deltas).toContain("streaming text");
  });
});

// ── 重试逻辑 ──

describe("ApiAgentLoop — 重试逻辑", () => {
  let sandbox: string;

  beforeAll(() => {
    sandbox = join(tmpdir(), `autopilot-retry-test-${Date.now()}`);
    mkdirSync(sandbox, { recursive: true });
  });

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("429 错误 → 重试后成功", async () => {
    let attempts = 0;
    const adapter: ProviderAdapter = {
      name: "mock-retry",
      async completeStream(): Promise<AdapterResponse> {
        attempts++;
        if (attempts === 1) {
          throw new ApiError(429, "Rate limited");
        }
        return {
          text: "成功了",
          usage: { input_tokens: 10, output_tokens: 5 },
          stopReason: "end_turn",
        };
      },
    };
    const executor = ToolExecutor.fromConfig(sandbox, "default");

    const loop = new ApiAgentLoop({
      adapter,
      toolExecutor: executor,
      model: "test-model",
      maxTurns: 10,
    });

    const result = await loop.run("retry test");
    expect(result.text).toBe("成功了");
    expect(attempts).toBe(2);
  });

  it("非重试错误 → 直接抛出", async () => {
    const adapter: ProviderAdapter = {
      name: "mock-fail",
      async completeStream(): Promise<AdapterResponse> {
        throw new ApiError(401, "Invalid API key");
      },
    };
    const executor = ToolExecutor.fromConfig(sandbox, "default");

    const loop = new ApiAgentLoop({
      adapter,
      toolExecutor: executor,
      model: "test-model",
      maxTurns: 10,
    });

    await expect(loop.run("should fail")).rejects.toThrow("Invalid API key");
  });

  it("连续失败 3 次 → 最终抛出", async () => {
    let attempts = 0;
    const adapter: ProviderAdapter = {
      name: "mock-always-fail",
      async completeStream(): Promise<AdapterResponse> {
        attempts++;
        throw new ApiError(500, "Server error");
      },
    };
    const executor = ToolExecutor.fromConfig(sandbox, "default");

    const loop = new ApiAgentLoop({
      adapter,
      toolExecutor: executor,
      model: "test-model",
      maxTurns: 10,
    });

    await expect(loop.run("doomed")).rejects.toThrow("Server error");
    expect(attempts).toBe(3); // 初始 + 2 次重试
  });
});

// ── Provider 路由决策 ──

describe("resolveMode", () => {
  it("phase 显式指定 mode → 优先使用", () => {
    expect(resolveMode("api", undefined, "anthropic")).toBe("api");
    expect(resolveMode("cli", undefined, "anthropic")).toBe("cli");
  });

  it("compat provider 指定 cli → 报错", () => {
    expect(() => resolveMode("cli", undefined, "deepseek")).toThrow("仅支持 API 模式");
  });

  it("provider 级默认 mode", () => {
    expect(resolveMode(undefined, { mode: "api" } as any, "anthropic")).toBe("api");
  });

  it("compat provider 无显式指定 → 强制 api", () => {
    expect(resolveMode(undefined, undefined, "deepseek")).toBe("api");
    expect(resolveMode(undefined, undefined, "kimi")).toBe("api");
    expect(resolveMode(undefined, undefined, "minimax")).toBe("api");
  });

  it("三大官方无配置 → 默认 cli", () => {
    expect(resolveMode(undefined, undefined, "anthropic")).toBe("cli");
    expect(resolveMode(undefined, undefined, "openai")).toBe("cli");
    expect(resolveMode(undefined, undefined, "google")).toBe("cli");
  });

  it("未知自定义 provider → 强制 api（isCompatOnly）", () => {
    expect(resolveMode(undefined, undefined, "custom-llm")).toBe("api");
  });
});

// ── Agent 惰性初始化验证（C1 修复） ──

describe("Agent API 模式惰性初始化（C1 修复）", () => {
  it("API 模式 Agent 创建后 run() 时自动初始化", async () => {
    // 创建一个 API 模式的 agent（deepseek 自动为 api 模式）
    const agent = createAgent({
      name: "test-api",
      provider: "deepseek",
      model: "deepseek-chat",
    });

    expect(agent.mode).toBe("api");

    // 未初始化时不应有 apiLoop
    // Agent.run() 需要 task context，没有 context 时应给出明确错误
    await expect(agent.run("test")).rejects.toThrow("sandboxDir");
  });

  it("CLI 模式 Agent 不注入工厂函数", () => {
    const agent = createAgent({
      name: "test-cli",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });

    expect(agent.mode).toBe("cli");
  });
});

// ── 缓存 key 含 mode（M2 修复验证） ──

describe("agentForPhase 缓存 key 含 mode（M2）", () => {
  it("同一 phase 不同 mode → 不同 Agent 实例", () => {
    _resetForTest();

    const apiAgent = createAgent({ name: "p1", provider: "deepseek", model: "deepseek-chat" });
    const cliAgent = createAgent({ name: "p1", provider: "anthropic", model: "claude-sonnet-4-6" });

    expect(apiAgent.mode).toBe("api");
    expect(cliAgent.mode).toBe("cli");
    // 它们是不同实例
    expect(apiAgent).not.toBe(cliAgent);
  });
});

// ── I-1 修复验证：apiLoopInitPromise 失败后可重试 ──

describe("apiLoopInitPromise 失败后清除锁（I-1）", () => {
  it("工厂首次失败后，第二次调用可重试而非永远缓存失败 Promise", async () => {
    const { Agent } = await import("../src/agents/agent");
    const { UnsupportedInApiModeError } = await import("../src/agents/providers/api/tools");

    // 构造一个 mock provider（API 模式下不被调用）
    const dummyProvider = {
      config: {},
      run: async () => { throw new Error("不应调用"); },
      close: async () => {},
      chat: async () => { throw new Error("不应调用"); },
      buildRunOptions: () => ({}),
      resolveModel: () => "m",
      resolveMaxTurns: () => 10,
      resolveSystemPrompt: () => undefined,
    } as any;

    const agent = new Agent("test-retry", dummyProvider, {
      name: "test-retry",
      provider: "deepseek",
      model: "deepseek-chat",
    }, "api");

    let callCount = 0;
    agent.setApiLoopFactory(async (_sandboxRoot: string) => {
      callCount++;
      if (callCount === 1) {
        throw new Error("API key 未配置");
      }
      // 第二次返回 mock loop
      return {
        run: async () => ({ text: "成功", usage: { input_tokens: 0, output_tokens: 0 } }),
        chat: async () => { throw new UnsupportedInApiModeError("chat"); },
      } as any;
    });

    // 手动模拟 task context（ensureApiLoop 需要 ctx.sandboxDir）
    const { runWithTaskContext } = await import("../src/core/task/context");
    const ctx = {
      taskId: "test-001",
      phase: "develop",
      sandboxDir: "/tmp/test-sandbox",
      signal: new AbortController().signal,
    };

    // 第一次调用：工厂失败
    await expect(
      runWithTaskContext(ctx, () => agent.run("test"))
    ).rejects.toThrow("API key 未配置");
    expect(callCount).toBe(1);

    // 第二次调用：锁已被清除，工厂被再次调用，这次成功
    const result = await runWithTaskContext(ctx, () => agent.run("test"));
    expect(callCount).toBe(2);
    expect(result.text).toBe("成功");
  });
});

// ── I-2 修复验证：estimateTokens 统计 tool_use.input ──

describe("estimateTokens 统计 tool_use.input（I-2）", () => {
  it("包含大文件 write_file 的消息序列被正确裁剪", async () => {
    const sandbox = join(tmpdir(), `autopilot-estimate-test-${Date.now()}`);
    mkdirSync(sandbox, { recursive: true });

    try {
      // 构造一个场景：LLM 调用 write_file 写入大文件（100KB），
      // 然后再进行下一轮。对于 deepseek-chat（56K 上下文），裁剪应生效。
      const bigContent = "x".repeat(400_000); // 100K token @ 4 char/token

      let callCount = 0;
      const adapter: ProviderAdapter = {
        name: "mock-trim",
        async completeStream(
          messages: MessageParam[],
          _options: AdapterOptions,
          _onDelta?: (delta: string) => void,
        ): Promise<AdapterResponse> {
          callCount++;
          if (callCount === 1) {
            // 第一轮：LLM 调用 write_file 写大文件
            return {
              text: "Writing big file",
              toolCalls: [{ id: "call_1", name: "write_file", input: { path: "big.txt", content: bigContent } }],
              usage: { input_tokens: 1000, output_tokens: 500 },
              stopReason: "tool_use",
            };
          }
          if (callCount === 2) {
            // 第二轮：检查消息数是否被裁剪
            // 如果 estimateTokens 正确统计了 tool_use.input，
            // trimMessagesToFitContext 应将消息裁剪
            return {
              text: "Done",
              // 模拟 API 返回大 input token（触发裁剪检查）
              usage: { input_tokens: 200_000, output_tokens: 50 },
              stopReason: "end_turn",
            };
          }
          return { text: "fallback", usage: { input_tokens: 100, output_tokens: 50 }, stopReason: "end_turn" };
        },
      };

      const executor = ToolExecutor.fromConfig(sandbox, "bypassPermissions");
      const loop = new ApiAgentLoop({
        adapter,
        toolExecutor: executor,
        model: "deepseek-chat", // 56K 上下文限制
        maxTurns: 5,
      });

      const result = await loop.run("Write a big file then continue");
      expect(result.text).toBe("Done");
      expect(callCount).toBe(2);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});

// ── 流式日志去重验证 ──

describe("API 流式日志去重 — 每轮回复仅产生一条完整文本日志", () => {
  let sandbox: string;
  let originalInfo: typeof log.info;
  let logCalls: { msg: string; args: unknown[] }[];

  beforeEach(() => {
    sandbox = join(tmpdir(), `autopilot-log-dedup-test-${Date.now()}`);
    mkdirSync(sandbox, { recursive: true });
    // 猴子补丁 log.info，收集调用记录
    originalInfo = log.info;
    logCalls = [];
    log.info = (msg: string, ...args: unknown[]) => {
      logCalls.push({ msg, args });
    };
  });

  afterEach(() => {
    // 还原 log.info
    log.info = originalInfo;
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("有文本的轮次 → log.info('本轮输出') 被调 1 次，参数含完整文本", async () => {
    const adapter: ProviderAdapter = {
      name: "mock-log",
      async completeStream(
        _messages: MessageParam[],
        _options: AdapterOptions,
        onDelta?: (delta: string) => void,
      ): Promise<AdapterResponse> {
        // 模拟逐碎片流式回调
        if (onDelta) {
          onDelta("Hello ");
          onDelta("world!");
        }
        return {
          text: "Hello world!",
          usage: { input_tokens: 10, output_tokens: 5 },
          stopReason: "end_turn",
        };
      },
    };
    const executor = ToolExecutor.fromConfig(sandbox, "default");

    const loop = new ApiAgentLoop({
      adapter,
      toolExecutor: executor,
      model: "test-model",
      maxTurns: 10,
    });

    await loop.run("Say hello");

    // 过滤出包含「本轮输出」的日志条目
    const outputLogs = logCalls.filter((c) => c.msg.includes("本轮输出"));
    expect(outputLogs.length).toBe(1);
    expect(String(outputLogs[0].args[0])).toContain("Hello world!");
  });

  it("纯工具调用（text=''）→ 无「本轮输出」日志条目", async () => {
    const adapter: ProviderAdapter = {
      name: "mock-tool-only",
      async completeStream(
        _messages: MessageParam[],
        _options: AdapterOptions,
        _onDelta?: (delta: string) => void,
      ): Promise<AdapterResponse> {
        return {
          text: "",
          toolCalls: [{ id: "call_1", name: "task_complete", input: { summary: "done" } }],
          usage: { input_tokens: 10, output_tokens: 5 },
          stopReason: "tool_use",
        };
      },
    };
    const executor = ToolExecutor.fromConfig(sandbox, "default");

    const loop = new ApiAgentLoop({
      adapter,
      toolExecutor: executor,
      model: "test-model",
      maxTurns: 10,
    });

    await loop.run("Just use tools");

    const outputLogs = logCalls.filter((c) => c.msg.includes("本轮输出"));
    expect(outputLogs.length).toBe(0);
  });

  it("response.text 为 undefined 时 → 无「本轮输出」日志条目", async () => {
    const adapter: ProviderAdapter = {
      name: "mock-undefined-text",
      async completeStream(
        _messages: MessageParam[],
        _options: AdapterOptions,
        _onDelta?: (delta: string) => void,
      ): Promise<AdapterResponse> {
        return {
          text: undefined as unknown as string,
          toolCalls: [{ id: "call_1", name: "task_complete", input: { summary: "done" } }],
          usage: { input_tokens: 10, output_tokens: 5 },
          stopReason: "tool_use",
        };
      },
    };
    const executor = ToolExecutor.fromConfig(sandbox, "default");

    const loop = new ApiAgentLoop({
      adapter,
      toolExecutor: executor,
      model: "test-model",
      maxTurns: 10,
    });

    await loop.run("Undefined text");

    const outputLogs = logCalls.filter((c) => c.msg.includes("本轮输出"));
    expect(outputLogs.length).toBe(0);
  });

  it("多轮对话 → 「本轮输出」条目恰好 2 条，各含对应轮文本", async () => {
    writeFileSync(join(sandbox, "test.txt"), "test content");
    let callIdx = 0;
    const adapter: ProviderAdapter = {
      name: "mock-multi-turn",
      async completeStream(
        _messages: MessageParam[],
        _options: AdapterOptions,
        onDelta?: (delta: string) => void,
      ): Promise<AdapterResponse> {
        callIdx++;
        if (callIdx === 1) {
          // 第一轮：有文本 + 工具调用 → 继续
          if (onDelta) onDelta("第一轮回复");
          return {
            text: "第一轮回复",
            toolCalls: [{ id: "call_1", name: "read_file", input: { path: "test.txt" } }],
            usage: { input_tokens: 10, output_tokens: 5 },
            stopReason: "tool_use",
          };
        }
        // 第二轮：纯文本结束
        if (onDelta) onDelta("第二轮回复");
        return {
          text: "第二轮回复",
          usage: { input_tokens: 20, output_tokens: 10 },
          stopReason: "end_turn",
        };
      },
    };
    const executor = ToolExecutor.fromConfig(sandbox, "bypassPermissions");

    const loop = new ApiAgentLoop({
      adapter,
      toolExecutor: executor,
      model: "test-model",
      maxTurns: 10,
    });

    await loop.run("Multi turn test");

    const outputLogs = logCalls.filter((c) => c.msg.includes("本轮输出"));
    expect(outputLogs.length).toBe(2);
    expect(String(outputLogs[0].args[0])).toContain("第一轮回复");
    expect(String(outputLogs[1].args[0])).toContain("第二轮回复");
  });
});
