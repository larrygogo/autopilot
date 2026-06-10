/**
 * 审批后内容冻结：requirements.update RPC 闸门 + canEditRequirementContent 谓词。
 * 规则：drafting/clarifying/ready/awaiting_approval/failed 可编辑 title/spec/workspace；
 * queued/running/awaiting_review/fix_revision/done/cancelled 冻结（执行内容以入队快照为准）。
 */
import { describe, it, expect } from "bun:test";
import { canEditRequirementContent } from "../src/web/src/lib/requirement-steps";

describe("canEditRequirementContent（审批后冻结谓词）", () => {
  it("审批前 + failed 可编辑", () => {
    for (const s of ["drafting", "clarifying", "ready", "awaiting_approval", "failed"]) {
      expect(canEditRequirementContent(s)).toBe(true);
    }
  });

  it("审批后（入队及之后）与死终态冻结", () => {
    for (const s of ["queued", "running", "awaiting_review", "fix_revision", "done", "cancelled"]) {
      expect(canEditRequirementContent(s)).toBe(false);
    }
  });

  it("未知状态默认冻结（保守）", () => {
    expect(canEditRequirementContent("weird-unknown")).toBe(false);
  });
});
