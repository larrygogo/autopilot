import { test, expect } from "bun:test";
import { withTimeout, CostBudget } from "../src/daemon/runner/cost-gate";

test("withTimeout：超时拒绝并带可识别标记", async () => {
  const slow = new Promise((r) => setTimeout(r, 100));
  await expect(withTimeout(slow, 10, "round")).rejects.toThrow(/round 超时/);
});

test("withTimeout：及时完成透传结果", async () => {
  expect(await withTimeout(Promise.resolve(42), 1000, "round")).toBe(42);
});

test("CostBudget：session 上限触顶", () => {
  const b = new CostBudget({ sessionMax: 2, stageMax: 5 });
  b.tickSession();
  b.tickSession();
  expect(b.sessionExceeded()).toBe(true);
});

test("CostBudget：per-stage 上限触顶（含 rework 轮累计）", () => {
  const b = new CostBudget({ sessionMax: 30, stageMax: 2 });
  b.tickStage("dev");
  b.tickStage("dev");
  expect(b.stageExceeded("dev")).toBe(true);
  expect(b.stageExceeded("spec")).toBe(false);
});
