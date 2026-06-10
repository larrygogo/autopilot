/**
 * 项目详情页需求 4 段 tab 分桶测试。
 * 映射规则（已修正）：
 *   等待人工：clarifying、awaiting_approval
 *   运行中：drafting、queued、running、awaiting_review、fix_revision、ready 及任何未知状态
 *   归档：done、cancelled、failed
 */
import { describe, it, expect } from "bun:test";
import { projectReqTab, requirementTab, type ProjectReqTab } from "../src/web/src/lib/requirement-buckets";

describe("projectReqTab（spec 的 tab 分桶表）", () => {
  const cases: Array<[string, ProjectReqTab]> = [
    // 等待人工
    ["clarifying", "human"],
    ["awaiting_approval", "human"],
    // 运行中
    ["drafting", "running"],
    ["ready", "running"],
    ["queued", "running"],
    ["running", "running"],
    ["fix_revision", "running"],
    ["awaiting_review", "running"],
    // 归档
    ["done", "archived"],
    ["cancelled", "archived"],
    ["failed", "archived"],
  ];
  for (const [status, tab] of cases) {
    it(`${status} → ${tab}`, () => expect(projectReqTab(status)).toBe(tab));
  }
  it("未知状态兜底 running（机器在跑的活跃状态）", () => {
    expect(projectReqTab("investigating")).toBe("running");
    expect(projectReqTab("whatever_new")).toBe("running");
  });
  it("projectReqTab 是 requirementTab 的别名", () => {
    expect(projectReqTab).toBe(requirementTab);
  });
});
