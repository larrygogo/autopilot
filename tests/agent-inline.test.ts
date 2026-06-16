/**
 * Phase 内联 agent 配置 + DEFAULT_AGENT 兜底（spec：移除命名复用 agent）
 *
 * 覆盖 agentForPhase 三种解析路径：
 *   1. phase.agent 为内联对象 → 覆盖 DEFAULT_AGENT
 *   2. phase 不配 agent      → 走 DEFAULT_AGENT
 *   3. phase.agent 为字符串   → 已废弃（命名 agent），warn 一次 + 回退 DEFAULT_AGENT
 * 以及缓存复用。
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register } from "../src/core/workflow/registry";
import { agentForPhase, _resetForTest } from "../src/agents/registry";
import { DEFAULT_AGENT } from "../src/core/agent-defaults";
import { saveProvider } from "../src/core/config";
import { Database } from "bun:sqlite";
import { _setDbForTest } from "../src/core/db";
import type { WorkflowDefinition, PhaseDefinition } from "../src/core/workflow/registry";

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

  test("旧格式字符串 agent → 废弃，warn + 回退 DEFAULT_AGENT", () => {
    const agent = agentForPhase(WF, "named");
    // 命名 agent 机制已移除：string 形态视为废弃，按 DEFAULT_AGENT 兜底
    // 匿名 agent 用 phase 名标识，配置等同 DEFAULT_AGENT
    expect(agent.name).toBe("named");
    expect(agent.config.provider).toBe(DEFAULT_AGENT.provider);
    expect(agent.config.model).toBe(DEFAULT_AGENT.model);
    expect(agent.config.system_prompt).toBe(DEFAULT_AGENT.system_prompt);
  });

  test("同 phase 重复解析复用同一实例（缓存）", () => {
    const a1 = agentForPhase(WF, "inline");
    const a2 = agentForPhase(WF, "inline");
    expect(a1).toBe(a2);
  });

  test("改 agent 字段后重注册 → 内容指纹变，返回新实例（不发旧缓存）", () => {
    const a1 = agentForPhase(WF, "inline");
    // 不清缓存、不重注册 → 命中
    expect(agentForPhase(WF, "inline")).toBe(a1);
    // 改 system_prompt 重注册同名工作流（模拟 workflow.yaml 改内联 agent 但未触发 config:updated）
    register({
      name: WF,
      phases: [
        { name: "inline", agent: { provider: "anthropic", model: "claude-opus-4-8", system_prompt: "你是评审员（已改）" } },
      ] as unknown as PhaseDefinition[],
    } as unknown as WorkflowDefinition);
    const a2 = agentForPhase(WF, "inline");
    expect(a2).not.toBe(a1); // 指纹变 → 缓存未命中
    expect(a2.config.system_prompt).toBe("你是评审员（已改）");
  });
});

// config 的 default_model 解析（修复：浅合并把 DEFAULT_AGENT.model 填满导致 default_model 成 dead fallback）
describe("agentForPhase — config default_model 三级回退", () => {
  let tmpFile: string;

  beforeEach(() => {
    _resetForTest();
    // 空内存 DB（无 provider entry）→ resolveEffectiveProvider 走 config 回退分支（不走 DB entry），
    // 这样 saveProvider 写的 config default_model 才会被读到。生产里有 entry 时 eff.default_model 来自
    // entry，本测验证的是「只要 eff.default_model 有值就不被 DEFAULT_AGENT 硬编码屏蔽」这一核心修复。
    _setDbForTest(new Database(":memory:"));
    const dir = join(tmpdir(), `autopilot-agentmodel-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    tmpFile = join(dir, "config.yaml");
    writeFileSync(tmpFile, "", "utf-8");
    process.env.DEV_WORKFLOW_CONFIG = tmpFile; // loadProviders 读它，不污染真实 config
  });

  afterEach(() => {
    _setDbForTest(null);
    delete process.env.DEV_WORKFLOW_CONFIG;
    if (tmpFile && existsSync(tmpFile)) rmSync(join(tmpFile, ".."), { recursive: true, force: true });
  });

  test("phase 未写 model + config 配了 default_model → 用 default_model（不再被 DEFAULT_AGENT 硬编码屏蔽）", () => {
    saveProvider("anthropic", { default_model: "claude-from-config-xyz" });
    register({
      name: "wf_dm_test",
      phases: [{ name: "bare" }] as unknown as PhaseDefinition[],
    } as unknown as WorkflowDefinition);

    const agent = agentForPhase("wf_dm_test", "bare");
    expect(agent.config.model).toBe("claude-from-config-xyz");
    expect(agent.config.model).not.toBe(DEFAULT_AGENT.model); // 反向确认不是硬编码兜底
  });

  test("phase 显式 model 仍优先于 config default_model", () => {
    saveProvider("anthropic", { default_model: "claude-from-config-xyz" });
    register({
      name: "wf_dm_test2",
      phases: [{ name: "explicit", agent: { provider: "anthropic", model: "claude-opus-4-8" } }] as unknown as PhaseDefinition[],
    } as unknown as WorkflowDefinition);

    const agent = agentForPhase("wf_dm_test2", "explicit");
    expect(agent.config.model).toBe("claude-opus-4-8"); // 显式 > default_model
  });
});
