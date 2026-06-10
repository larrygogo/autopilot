import { test, expect } from "bun:test";
import { statusToStep, stepPosition, resolveCurrentStep, STEP_ORDER, STEPS } from "./requirement-steps";

test("statusToStep: 12 个 status 映射到 6 步", () => {
  expect(statusToStep("drafting")).toBe("clarify");
  expect(statusToStep("clarifying")).toBe("clarify");
  expect(statusToStep("investigating")).toBe("clarify");
  expect(statusToStep("ready")).toBe("approve");
  expect(statusToStep("awaiting_approval")).toBe("approve");
  expect(statusToStep("queued")).toBe("queue");
  expect(statusToStep("running")).toBe("execute");
  expect(statusToStep("fix_revision")).toBe("execute");
  expect(statusToStep("awaiting_review")).toBe("review");
  expect(statusToStep("done")).toBe("done");
  expect(statusToStep("failed")).toBe("done");
  expect(statusToStep("cancelled")).toBe("done");
});

test("statusToStep: 未知 status 落到 done", () => {
  expect(statusToStep("weird-unknown")).toBe("done");
});

test("STEP_ORDER 是 6 步固定顺序", () => {
  expect(STEP_ORDER).toEqual(["clarify", "approve", "queue", "execute", "review", "done"]);
});

test("stepPosition: past/current/future", () => {
  expect(stepPosition("clarify", "execute")).toBe("past");
  expect(stepPosition("execute", "execute")).toBe("current");
  expect(stepPosition("review", "execute")).toBe("future");
});

test("resolveCurrentStep: 终态时定位死亡步，✗ 画在实际失败处", () => {
  // req-011 场景：执行期（running）被驳回触顶取消 → 死亡步是「执行」
  expect(resolveCurrentStep("cancelled", "running")).toBe("execute");
  expect(resolveCurrentStep("failed", "running")).toBe("execute");
  expect(resolveCurrentStep("failed", "awaiting_review")).toBe("review");
  expect(resolveCurrentStep("cancelled", "clarifying")).toBe("clarify");
  // 无 status_before_terminal（历史数据）兜底回「完成」步（旧行为）
  expect(resolveCurrentStep("cancelled", null)).toBe("done");
  expect(resolveCurrentStep("cancelled", undefined)).toBe("done");
  // 非终态不受影响
  expect(resolveCurrentStep("running", "clarifying")).toBe("execute");
  expect(resolveCurrentStep("done", null)).toBe("done");
});

test("STEPS 含 6 项，key 顺序与 label 文案正确", () => {
  expect(STEPS.map((s) => s.key)).toEqual(["clarify", "approve", "queue", "execute", "review", "done"]);
  expect(STEPS.map((s) => s.label)).toEqual(["澄清", "审批", "排队", "执行", "验收", "完成"]);
  for (const s of STEPS) expect(s.label.trim().length).toBeGreaterThan(0);
});
