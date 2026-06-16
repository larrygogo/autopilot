import { test, expect } from "bun:test";
import { classifyFeedback, FEEDBACK_RESIDUE_PREFIX } from "./feedback-classify";

test("from_role=agent + 执行评审遗留前缀 → residue（历史失败 run 遗留，非本 PR）", () => {
  expect(classifyFeedback("agent", "【执行评审遗留 · task d73vvfjx】方案评审驳回 3 次")).toBe("residue");
  expect(classifyFeedback("agent", `${FEEDBACK_RESIDUE_PREFIX} x】y`)).toBe("residue");
});

test("from_role=agent + 修复总结前缀 → fix（Agent 修复，不是遗留）", () => {
  expect(classifyFeedback("agent", "【修复完成】已修省略号宽度")).toBe("fix");
  expect(classifyFeedback("agent", "【修复完成 · 第 2 轮交付】...")).toBe("fix");
});

test("from_role=agent 其它 body → fix（兜底当修复，不误标 review）", () => {
  expect(classifyFeedback("agent", "随便什么 agent 总结")).toBe("fix");
});

test("from_role=user / github → review（用户 / GitHub 评审意见）", () => {
  expect(classifyFeedback("user", "我觉得这里要改")).toBe("review");
  expect(classifyFeedback("github", "Changes requested: fix X")).toBe("review");
  // 即便 user 的 body 巧合带遗留前缀，也按 review（residue 仅限 agent）
  expect(classifyFeedback("user", "【执行评审遗留 ...】")).toBe("review");
});
