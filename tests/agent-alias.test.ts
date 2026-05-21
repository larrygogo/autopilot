/**
 * Phase 7 — agent 别名测试（spec §3.11.1）
 *
 * 覆盖：
 *   - resolveAliasTarget 单跳成功 / 不在表里返回原名 / 多跳拒绝
 *   - resolveAgentConfig: workflow.agents[] 优先 / globalAgents 同名优先 / alias fallback
 *   - merged.name 保留原 agentName（UI 显示用户视角）
 */

import { describe, it, expect } from "bun:test";
import { resolveAliasTarget, resolveAgentConfig } from "../src/agents/registry";
import type { ProviderName } from "../src/agents/types";

describe("resolveAliasTarget", () => {
  it("不在表里 → 返回原名", () => {
    expect(resolveAliasTarget("coder", {})).toBe("coder");
    expect(resolveAliasTarget("coder", { other: "x" })).toBe("coder");
  });

  it("单跳命中", () => {
    expect(resolveAliasTarget("code-reviewer", { "code-reviewer": "reviewer" })).toBe("reviewer");
  });

  it("多跳拒绝（链式 alias）", () => {
    expect(() =>
      resolveAliasTarget("a", { a: "b", b: "c" }),
    ).toThrow(/链式/);
  });

  it("多跳的中间也指向自身循环 → 仍拒绝", () => {
    expect(() =>
      resolveAliasTarget("a", { a: "b", b: "a" }),
    ).toThrow(/链式/);
  });
});

describe("resolveAgentConfig with aliases", () => {
  const globalAgents = {
    reviewer: { provider: "anthropic", model: "claude-sonnet-4-6", system_prompt: "审稿员" },
    architect: { provider: "anthropic", model: "claude-opus-4-7", system_prompt: "架构师" },
  };
  const providers = {};

  it("alias 命中 + base 用 target 配置 + merged.name 保留原名", () => {
    const aliases = { "code-reviewer": "reviewer" };
    const result = resolveAgentConfig("code-reviewer", undefined, globalAgents, providers, aliases);
    expect(result.name).toBe("code-reviewer"); // 用户视角保留
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-sonnet-4-6");
    expect((result as Record<string, unknown>)["system_prompt"]).toBe("审稿员");
  });

  it("workflow.agents[] 显式定义 → alias 不生效", () => {
    const aliases = { "code-reviewer": "reviewer" };
    // workflow 给 code-reviewer 自定义了 provider=openai
    const workflowAgent = { name: "code-reviewer", provider: "openai" as ProviderName, model: "gpt-5" };
    const result = resolveAgentConfig(
      "code-reviewer",
      workflowAgent,
      globalAgents,
      providers,
      aliases,
    );
    expect(result.name).toBe("code-reviewer");
    // workflow 覆盖优先：用 openai 不用 reviewer 的 anthropic
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-5");
  });

  it("globalAgents 同名存在 → 不走 alias（同名直接命中）", () => {
    const aliases = { "code-reviewer": "reviewer" };
    const globalsWithCodeReviewer = {
      ...globalAgents,
      "code-reviewer": { provider: "google", model: "gemini-2.5-pro" },
    };
    const result = resolveAgentConfig(
      "code-reviewer",
      undefined,
      globalsWithCodeReviewer,
      providers,
      aliases,
    );
    // 走 globalAgents 同名条目（google），不去取 alias target（reviewer / anthropic）
    expect(result.provider).toBe("google");
    expect(result.model).toBe("gemini-2.5-pro");
  });

  it("alias target 不在 globalAgents → 退回原 baseKey 空 base + workflow 必须提供 provider", () => {
    const aliases = { "code-reviewer": "nonexistent" };
    // 既无 globalAgents[code-reviewer] 也无 globalAgents[nonexistent] → base 为空
    // workflowAgent 也未提供 → 缺 provider，抛错
    expect(() =>
      resolveAgentConfig("code-reviewer", undefined, globalAgents, providers, aliases),
    ).toThrow(/provider/);
  });

  it("无 alias 且无 globalAgents 同名 → 缺 provider 抛错", () => {
    expect(() =>
      resolveAgentConfig("unknown-agent", undefined, globalAgents, providers, {}),
    ).toThrow(/provider/);
  });
});
