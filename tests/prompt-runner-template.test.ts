import { describe, it, expect } from "bun:test";
import { expandPromptTemplate } from "../src/core/prompt-runner";

describe("expandPromptTemplate · REJECTION", () => {
  const base = { taskId: "t1", phase: "design", workspaceRoot: "/tmp/x" };
  it("有驳回理由 → ${REJECTION} 注入；${REJECTION_COUNT} = 计数之和", () => {
    const out = expandPromptTemplate("上次驳回：${REJECTION}（第${REJECTION_COUNT}次）", {
      ...base,
      task: { rejection_reason: "缺测试", rejection_counts: JSON.stringify({ review: 2 }) },
    });
    expect(out).toBe("上次驳回：缺测试（第2次）");
  });
  it("无驳回 → ${REJECTION} 空串、${REJECTION_COUNT}=0", () => {
    const out = expandPromptTemplate("理由[${REJECTION}]次${REJECTION_COUNT}", { ...base, task: {} });
    expect(out).toBe("理由[]次0");
  });
});
