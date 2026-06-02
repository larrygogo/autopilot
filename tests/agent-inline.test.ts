/**
 * Phase 内联 agent 配置 + DEFAULT_AGENT 兜底（spec：移除命名复用 agent）
 *
 * 覆盖 agentForPhase 三种解析路径：
 *   1. phase.agent 为内联对象 → 覆盖 DEFAULT_AGENT
 *   2. phase 不配 agent      → 走 DEFAULT_AGENT
 *   3. phase.agent 为字符串   → 旧格式兼容（降级到命名 agent getAgent）
 * 以及缓存复用。
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { register } from "../src/core/registry";
import { agentForPhase, _resetForTest } from "../src/agents/registry";
import { DEFAULT_AGENT } from "../src/core/agent-defaults";
import type { WorkflowDefinition, PhaseDefinition } from "../src/core/registry";

const WF = "wf_inline_agent_test";

/** 注册一个最小工作流：getPhase 只读 .name/.agent，其余字段不影响本测 */
function registerTestWorkflow(): void {
  const phases = [
    { name: "inline", agent: { provider: "anthropic", model: "claude-opus-4-8", system_prompt: "你是架构师" } },
    { name: "bare" },
    { name: "named", agent: "coder" },
  ] as unknown as PhaseDefinition[];
  register({ name: WF, phases } as unknown as WorkflowDefinition);
}

describe("agentForPhase — phase 内联 agent 配置", () => {
  beforeEach(() => {
    _resetForTest();
    registerTestWorkflow();
  });

  test("内联对象覆盖 DEFAULT_AGENT", () => {
    const agent = agentForPhase(WF, "inline");
    expect(agent.config.provider).toBe("anthropic");
    expect(agent.config.model).toBe("claude-opus-4-8");        // 内联覆盖
    expect(agent.config.system_prompt).toBe("你是架构师");      // 内联覆盖
    expect(agent.config.max_turns).toBe(DEFAULT_AGENT.max_turns); // 未写 → 继承默认
    expect(agent.name).toBe("inline");                          // 匿名 agent 用 phase 名标识
  });

  test("不配 agent → 走 DEFAULT_AGENT 兜底", () => {
    const agent = agentForPhase(WF, "bare");
    expect(agent.config.provider).toBe(DEFAULT_AGENT.provider);
    expect(agent.config.model).toBe(DEFAULT_AGENT.model);
    expect(agent.config.system_prompt).toBe(DEFAULT_AGENT.system_prompt);
    expect(agent.name).toBe("bare");
  });

  test("旧格式字符串 agent 仍可用（兼容降级）", () => {
    const agent = agentForPhase(WF, "named");
    // 走 getAgent("coder") 命名路径，name 保留为命名 agent 名
    expect(agent.name).toBe("coder");
    expect(agent.config.provider).toBe("anthropic");
  });

  test("同 phase 重复解析复用同一实例（缓存）", () => {
    const a1 = agentForPhase(WF, "inline");
    const a2 = agentForPhase(WF, "inline");
    expect(a1).toBe(a2);
  });
});
