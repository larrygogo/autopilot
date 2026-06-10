/**
 * 项目详情页需求 4 段 tab 分桶测试。
 * spec: docs/superpowers/specs/2026-06-10-project-pipeline-list-and-ga-task-view-design.md
 */
import { describe, it, expect } from "bun:test";
import { projectReqTab, type ProjectReqTab } from "../src/web/src/lib/requirement-buckets";

describe("projectReqTab（spec 的 tab 分桶表）", () => {
  const cases: Array<[string, ProjectReqTab]> = [
    ["drafting", "human"],
    ["clarifying", "human"],
    ["ready", "human"],
    ["awaiting_approval", "human"],
    ["awaiting_review", "human"],
    ["failed", "human"],
    ["queued", "running"],
    ["running", "running"],
    ["fix_revision", "running"],
    ["done", "archived"],
    ["cancelled", "archived"],
  ];
  for (const [status, tab] of cases) {
    it(`${status} → ${tab}`, () => expect(projectReqTab(status)).toBe(tab));
  }
  it("未知状态兜底 human（球在你这，宁可误报不漏报）", () => {
    expect(projectReqTab("investigating")).toBe("human");
    expect(projectReqTab("whatever_new")).toBe("human");
  });
});
