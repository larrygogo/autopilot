import { describe, it, expect } from "bun:test";
import { projectReqTab, requirementTab } from "../src/web/src/lib/requirement-buckets";

// 分桶原则 = 「球在谁手里」，与流水线页（Tasks.tsx）的需求分桶语义对齐。
// 曾经漂移：本函数把 awaiting_review/drafting/ready 归「运行中」、failed 归「归档」，
// 流水线却把它们归「等待人工」——同一条需求两个页面分类不同（dogfood 实锤 req-019）。
describe("requirementTab", () => {
  it("等待人工：drafting（确认代码库/开始澄清）", () => expect(requirementTab("drafting")).toBe("human"));
  it("等待人工：clarifying（回答 AI 提问）", () => expect(requirementTab("clarifying")).toBe("human"));
  it("等待人工：ready（提交审批）", () => expect(requirementTab("ready")).toBe("human"));
  it("等待人工：awaiting_approval（审批签字）", () => expect(requirementTab("awaiting_approval")).toBe("human"));
  it("等待人工：awaiting_review（去 review/merge PR）", () => expect(requirementTab("awaiting_review")).toBe("human"));
  it("等待人工：failed（停下报人，决定重试或放弃）", () => expect(requirementTab("failed")).toBe("human"));

  it("运行中：queued", () => expect(requirementTab("queued")).toBe("running"));
  it("运行中：running", () => expect(requirementTab("running")).toBe("running"));
  it("运行中：fix_revision（agent 修复中）", () => expect(requirementTab("fix_revision")).toBe("running"));

  it("归档：done", () => expect(requirementTab("done")).toBe("archived"));
  it("归档：cancelled", () => expect(requirementTab("cancelled")).toBe("archived"));

  it("未知状态兜底为等待人工（宁可提醒不可漏）", () => expect(requirementTab("some_future_status")).toBe("human"));

  it("projectReqTab 是 requirementTab 的别名（ProjectDetail 迁移期兼容）", () => {
    expect(projectReqTab).toBe(requirementTab);
  });
});
