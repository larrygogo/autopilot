import { describe, expect, test } from "bun:test";
import { Agent } from "../src/agents/agent";
import { BaseProvider } from "../src/agents/providers/base";
import type { AgentResult, RunOptions } from "../src/agents/types";
import { resolveAgentConfig } from "../src/agents/registry";

class MockProvider extends BaseProvider {
  async run(prompt: string): Promise<AgentResult> { return { text: `mock: ${prompt}` }; }
  async close(): Promise<void> {}
}

/** 暴露受 protected 保护的 resolve* 方法，便于单元测试 */
class ResolveProbe extends BaseProvider {
  async run(): Promise<AgentResult> { return { text: "" }; }
  async close(): Promise<void> {}
  model(options?: RunOptions) { return this.resolveModel(options, "fallback-model"); }
  maxTurns(options?: RunOptions) { return this.resolveMaxTurns(options, 7); }
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

  test("createAgent throws for unknown provider", () => {
    const { createAgent } = require("../src/agents/registry");
    expect(() => createAgent({ name: "a", provider: "unknown" as any, model: "m" })).toThrow("未知 provider");
  });
});

describe("resolveAgentConfig — 三层合并", () => {
  const globals = {
    coder: { provider: "anthropic", model: "claude-sonnet-4-6", max_turns: 10, system_prompt: "你是编码助手" },
    reviewer: { provider: "anthropic", model: "claude-opus-4-7", system_prompt: "你是审查员" },
  };

  test("workflow 未定义时直接使用全局 agent", () => {
    const cfg = resolveAgentConfig("coder", undefined, globals);
    expect(cfg.provider).toBe("anthropic");
    expect(cfg.model).toBe("claude-sonnet-4-6");
    expect(cfg.system_prompt).toBe("你是编码助手");
    expect(cfg.name).toBe("coder");
  });

  test("workflow 覆盖全局字段", () => {
    const cfg = resolveAgentConfig(
      "coder",
      { name: "coder", max_turns: 30, system_prompt: "专写 Go" },
      globals
    );
    expect(cfg.model).toBe("claude-sonnet-4-6");      // 继承
    expect(cfg.max_turns).toBe(30);                    // 覆盖
    expect(cfg.system_prompt).toBe("专写 Go");         // 覆盖
  });

  test("extends 指定别名基底", () => {
    const cfg = resolveAgentConfig(
      "go_coder",
      { name: "go_coder", extends: "coder", system_prompt: "专写 Go" },
      globals
    );
    expect(cfg.provider).toBe("anthropic");
    expect(cfg.model).toBe("claude-sonnet-4-6");
    expect(cfg.system_prompt).toBe("专写 Go");
    expect("extends" in cfg).toBe(false);              // 合并后应被清理
  });

  test("extends: null 关闭继承", () => {
    const cfg = resolveAgentConfig(
      "coder",
      { name: "coder", extends: null, provider: "openai", model: "o4-mini" },
      globals
    );
    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("o4-mini");
    expect(cfg.system_prompt).toBeUndefined();         // 不再继承
  });

  test("全局与 workflow 都没定义 provider 时抛错", () => {
    expect(() =>
      resolveAgentConfig("ghost", { name: "ghost" }, {})
    ).toThrow(/缺少 provider/);
  });

  test("未知 provider 抛错", () => {
    expect(() =>
      resolveAgentConfig("x", { name: "x", provider: "unknown" as any }, {})
    ).toThrow("未知 provider");
  });

  test("agent 未指定 model 时使用 providers.<provider>.default_model", () => {
    const cfg = resolveAgentConfig(
      "coder",
      { name: "coder", provider: "anthropic" },
      {},
      { anthropic: { default_model: "claude-opus-4-7" }, openai: {}, google: {} }
    );
    expect(cfg.model).toBe("claude-opus-4-7");
  });

  test("agent 自己的 model 优先于 provider 默认", () => {
    const cfg = resolveAgentConfig(
      "coder",
      { name: "coder", provider: "anthropic", model: "claude-haiku-4-5" },
      {},
      { anthropic: { default_model: "claude-opus-4-7" }, openai: {}, google: {} }
    );
    expect(cfg.model).toBe("claude-haiku-4-5");
  });

  test("provider 默认 model 缺失时保持 agent.model 为 undefined（交由 provider 自身 fallback）", () => {
    const cfg = resolveAgentConfig(
      "coder",
      { name: "coder", provider: "anthropic" },
      {},
      { anthropic: {}, openai: {}, google: {} }
    );
    expect(cfg.model).toBeUndefined();
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

  test("resolveMaxTurns: RunOptions > config > 默认", () => {
    const p = new ResolveProbe({ max_turns: 20 });
    expect(p.maxTurns()).toBe(20);
    expect(p.maxTurns({ max_turns: 50 })).toBe(50);
    expect(new ResolveProbe({}).maxTurns()).toBe(7);
  });

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
