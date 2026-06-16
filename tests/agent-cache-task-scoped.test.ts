import { describe, it, expect, beforeEach } from "bun:test";
import { register } from "../src/core/workflow/registry";
import { agentForPhase, _resetForTest } from "../src/agents/registry";
import { runWithTaskContext } from "../src/core/task/context";
import type { WorkflowDefinition, PhaseDefinition } from "../src/core/workflow/registry";

// 回归 #2：API 模式 agent 首次 run 把 ToolExecutor.sandboxRoot 冻结到当时 task 沙盒。
// 旧 cacheKey 不含 taskId → max_concurrent>1 时并发同工作流任务共用实例 → 读写串沙盒。
// 修复后 API 模式按 taskId 隔离缓存；CLI 模式保留跨 task 会话复用。

const WF = "wf_cache_taskscope_test";

function reg(): void {
  const phases = [
    // 非官方 provider(compat) → resolveMode = api
    { name: "apiphase", agent: { provider: "deepseek", model: "deepseek-chat" } },
    // 官方 provider → cli
    { name: "cliphase", agent: { provider: "anthropic", model: "claude-sonnet-4-6" } },
  ] as unknown as PhaseDefinition[];
  register({ name: WF, phases } as unknown as WorkflowDefinition);
}

const ctxA = { taskId: "task-aaaa", phase: "apiphase", sandboxDir: "/tmp/sbx-a" };
const ctxB = { taskId: "task-bbbb", phase: "apiphase", sandboxDir: "/tmp/sbx-b" };

describe("agentForPhase 缓存按 taskId 隔离（API 模式）", () => {
  beforeEach(() => {
    _resetForTest();
    reg();
  });

  it("API 模式：不同 task → 不同实例（不串沙盒）", () => {
    const a = runWithTaskContext(ctxA, () => agentForPhase(WF, "apiphase")) as ReturnType<typeof agentForPhase>;
    const b = runWithTaskContext(ctxB, () => agentForPhase(WF, "apiphase")) as ReturnType<typeof agentForPhase>;
    expect(a).not.toBe(b);
  });

  it("API 模式：同 task → 同实例（仍复用，不浪费）", () => {
    const a1 = runWithTaskContext(ctxA, () => agentForPhase(WF, "apiphase")) as ReturnType<typeof agentForPhase>;
    const a2 = runWithTaskContext(ctxA, () => agentForPhase(WF, "apiphase")) as ReturnType<typeof agentForPhase>;
    expect(a1).toBe(a2);
  });

  it("CLI 模式：不同 task → 同实例（保留跨 task 会话复用，不按 taskId 分裂）", () => {
    const a = runWithTaskContext(ctxA, () => agentForPhase(WF, "cliphase")) as ReturnType<typeof agentForPhase>;
    const b = runWithTaskContext(ctxB, () => agentForPhase(WF, "cliphase")) as ReturnType<typeof agentForPhase>;
    expect(a).toBe(b);
  });
});
