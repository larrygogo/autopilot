import { describe, expect, test } from "bun:test";
import { Agent } from "../src/agents/agent";
import { BaseProvider } from "../src/agents/providers/base";
import type { AgentResult, RunOptions } from "../src/agents/types";

class MockProvider extends BaseProvider {
  async run(prompt: string): Promise<AgentResult> { return { text: `mock: ${prompt}` }; }
  async close(): Promise<void> {}
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
    // 只测 createAgent 本身不调 SDK（AnthropicProvider 构造函数不需要 SDK）
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
