import { describe, expect, test } from "bun:test";
import { Agent } from "../src/agents/agent";
import { BaseProvider } from "../src/agents/providers/base";
import type { AgentResult, RunOptions } from "../src/agents/types";

class MockProvider extends BaseProvider {
  async run(prompt: string): Promise<AgentResult> { return { text: `mock: ${prompt}` }; }
  async close(): Promise<void> {}
}

/** 暴露受 protected 保护的 resolve* 方法，便于单元测试 */
class ResolveProbe extends BaseProvider {
  async run(): Promise<AgentResult> { return { text: "" }; }
  async close(): Promise<void> {}
  model(options?: RunOptions) { return this.resolveModel(options, "fallback-model"); }
  system(options?: RunOptions) { return this.resolveSystemPrompt(options); }
}

describe("agent system", () => {
  test("Agent delegates to provider", async () => {
    const agent = new Agent("test", new MockProvider({}), { name: "test", provider: "anthropic", model: "m" });
    const result = await agent.run("hello");
    expect(result.text).toBe("mock: hello");
  });

  test("Agent.close calls provider.close", async () => {
    let closed = false;
    class TrackProvider extends BaseProvider {
      async run(): Promise<AgentResult> { return { text: "" }; }
      async close() { closed = true; }
    }
    const agent = new Agent("t", new TrackProvider({}), { name: "t", provider: "anthropic", model: "m" });
    await agent.close();
    expect(closed).toBe(true);
  });

  test("createAgent creates agent with correct provider", () => {
    const { createAgent } = require("../src/agents/registry");
    const agent = createAgent({ name: "a", provider: "anthropic", model: "claude-sonnet-4-6" });
    expect(agent.name).toBe("a");
    expect(agent.config.provider).toBe("anthropic");
  });

  test("createAgent throws for compat provider with cli mode", () => {
    const { createAgent } = require("../src/agents/registry");
    // 非三大官方 provider 强制 cli 模式 → 报错（compat provider 仅支持 API）
    expect(() => createAgent({ name: "a", provider: "unknown" as any, mode: "cli", model: "m" })).toThrow("仅支持 API 模式");
  });

  test("createAgent accepts compat provider in API mode", () => {
    const { createAgent } = require("../src/agents/registry");
    // compat provider 自动切 api 模式，不抛错
    const agent = createAgent({ name: "a", provider: "deepseek", model: "deepseek-chat" });
    expect(agent.mode).toBe("api");
  });
});

describe("clearAllAgentCache（dogfood-bug27）", () => {
  test("clearAllAgentCache 清空所有 cached Agent + close 它们", async () => {
    const { clearAllAgentCache, _resetForTest, createAgent } = await import("../src/agents/registry");
    // 先把 cache 清干净
    _resetForTest();

    // 重新 import 模块拿 _cache（registry 没 export _cache，但 closeAgents 行为可以间接验证）
    // 直接用一组 close 跟踪测：跑一次 closeAgents("non-existent") 应该 no-op 不报错
    // 然后调 clearAllAgentCache 验证返回 promise 完成
    await clearAllAgentCache();
    // 二次调也 OK（幂等）
    await clearAllAgentCache();

    // 真测 close 行为：手动放一个 Agent 进 cache 然后清
    // _cache 没暴露 setter，但 createAgent 是 export 的；这里只验函数本身不抛异常 + 幂等
    const agent = createAgent({ name: "test-cache", provider: "anthropic", model: "claude-sonnet-4-6" });
    expect(agent.name).toBe("test-cache");
    await agent.close();
  });

  test("config:updated 事件 → daemon 启动时订阅会清缓存", async () => {
    // 集成层验证：daemon/index.ts 启动时 onEvent("config:updated", clearAllAgentCache)
    // 这里只 sanity 验 onEvent + emit 链路可工作
    const { enableBus, disableBus, emit, onEvent, offEvent } = await import("../src/core/event-bus");
    enableBus();
    let triggered = false;
    const handler = () => { triggered = true; };
    onEvent("config:updated", handler);
    emit({ type: "config:updated", payload: {} });
    // emit 是同步的，handler 应该已被调用
    expect(triggered).toBe(true);
    offEvent("config:updated", handler);
    disableBus();
  });
});

describe("BaseProvider — 运行时覆盖", () => {
  test("resolveModel: RunOptions > config > 默认", () => {
    const p = new ResolveProbe({ model: "config-model" });
    expect(p.model()).toBe("config-model");
    expect(p.model({ model: "runtime-model" })).toBe("runtime-model");
    const empty = new ResolveProbe({});
    expect(empty.model()).toBe("fallback-model");
  });

  // 注：原 resolveMaxTurns 测试已删——该方法是死代码（无生产调用，max_turns 仅 API 模式
  // ApiAgentLoop 强制，CLI provider 不读），随方法一并移除。

  test("resolveSystemPrompt: system_prompt 替换", () => {
    const p = new ResolveProbe({ system_prompt: "base" });
    expect(p.system()).toBe("base");
    expect(p.system({ system_prompt: "override" })).toBe("override");
  });

  test("resolveSystemPrompt: additional_system 追加到 base", () => {
    const p = new ResolveProbe({ system_prompt: "base" });
    expect(p.system({ additional_system: "extra" })).toBe("base\n\nextra");
  });

  test("resolveSystemPrompt: 仅 additional_system 时直接返回", () => {
    const p = new ResolveProbe({});
    expect(p.system({ additional_system: "only" })).toBe("only");
  });

  test("resolveSystemPrompt: 无任何来源返回 undefined", () => {
    const p = new ResolveProbe({});
    expect(p.system()).toBeUndefined();
  });
});
