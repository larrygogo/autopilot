/**
 * submit_decision 工具 + 捕获位（pending-decisions）。
 */
import { describe, it, expect } from "bun:test";
import { captureDecision, takeDecision, clearDecision } from "../src/agents/pending-decisions";
import { buildWorkflowAgentTools } from "../src/agents/tools";
import { runWithTaskContext } from "../src/core/task/context";
import type { RegisteredTool } from "../src/agents/mcp-tools";

describe("pending-decisions 捕获位", () => {
  it("capture → take（读后删，单消费）", () => {
    captureDecision("t1", { verdict: "pass", reason: "" });
    expect(takeDecision("t1")).toEqual({ verdict: "pass", reason: "" });
    expect(takeDecision("t1")).toBeNull(); // 读后删
  });

  it("同 task 多次 capture 以最后一次为准", () => {
    captureDecision("t2", { verdict: "pass", reason: "" });
    captureDecision("t2", { verdict: "reject", reason: "不行" });
    expect(takeDecision("t2")).toEqual({ verdict: "reject", reason: "不行" });
  });

  it("clearDecision 清残留", () => {
    captureDecision("t3", { verdict: "pass", reason: "" });
    clearDecision("t3");
    expect(takeDecision("t3")).toBeNull();
  });
});

async function submitDecisionTool(): Promise<RegisteredTool> {
  const tools = await buildWorkflowAgentTools();
  const t = tools.find((x) => x.name === "submit_decision");
  if (!t) throw new Error("submit_decision 工具未注册");
  return t;
}

describe("submit_decision 工具 handler", () => {
  it("已注册进 WORKFLOW_TOOL_NAMES", async () => {
    const { WORKFLOW_TOOL_NAMES } = await import("../src/agents/tools");
    expect(WORKFLOW_TOOL_NAMES).toContain("submit_decision");
  });

  it("phase 上下文内 verdict=pass → 写捕获位", async () => {
    const t = await submitDecisionTool();
    clearDecision("ctxA");
    const res = await runWithTaskContext({ taskId: "ctxA", phase: "review" }, () =>
      t.handler({ verdict: "pass", reason: "" }),
    );
    expect(res.content[0].text).toContain("recorded");
    expect(takeDecision("ctxA")).toEqual({ verdict: "pass", reason: "" });
  });

  it("reject + reason → 写捕获位（reason 去空白）", async () => {
    const t = await submitDecisionTool();
    clearDecision("ctxB");
    await runWithTaskContext({ taskId: "ctxB", phase: "review" }, () =>
      t.handler({ verdict: "reject", reason: "  缺测试  " }),
    );
    expect(takeDecision("ctxB")).toEqual({ verdict: "reject", reason: "缺测试" });
  });

  it("reject 无 reason → 报错，不写捕获位", async () => {
    const t = await submitDecisionTool();
    clearDecision("ctxC");
    const res = await runWithTaskContext({ taskId: "ctxC", phase: "review" }, () =>
      t.handler({ verdict: "reject", reason: "" }),
    );
    expect(res.content[0].text).toContain("错误");
    expect(takeDecision("ctxC")).toBeNull();
  });

  it("无 phase 上下文 → 报错（地基缺失时的安全分支）", async () => {
    const t = await submitDecisionTool();
    const res = await t.handler({ verdict: "pass", reason: "" });
    expect(res.content[0].text).toContain("phase 上下文");
  });
});
