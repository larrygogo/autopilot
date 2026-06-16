import { test, expect } from "bun:test";
import { computeRunLabels, runOutcome, normKind, type RunLike } from "./run-label";

function run(p: Partial<RunLike> & { id: string }): RunLike {
  return { status: "done", ...p };
}

test("normKind: 缺省/未知当 execution，fix 保留", () => {
  expect(normKind(undefined)).toBe("execution");
  expect(normKind(null)).toBe("execution");
  expect(normKind("execution")).toBe("execution");
  expect(normKind("weird")).toBe("execution");
  expect(normKind("fix")).toBe("fix");
});

test("computeRunLabels: 单次执行叫「执行」不带 #N", () => {
  const labels = computeRunLabels([run({ id: "a", kind: "execution", seq: 1 })]);
  expect(labels.get("a")).toBe("执行");
});

test("computeRunLabels: 多次执行带 #N，按 seq 升序次序", () => {
  const labels = computeRunLabels([
    run({ id: "a", kind: "execution", seq: 1 }),
    run({ id: "b", kind: "execution", seq: 3 }),
  ]);
  expect(labels.get("a")).toBe("执行 #1");
  expect(labels.get("b")).toBe("执行 #2");
});

test("computeRunLabels: fix 轮独立编号「修复轮 #M」", () => {
  const labels = computeRunLabels([
    run({ id: "a", kind: "execution", seq: 1 }),
    run({ id: "b", kind: "fix", seq: 2 }),
    run({ id: "c", kind: "fix", seq: 3 }),
  ]);
  // 只有一个 execution → 叫「执行」（不带 #）
  expect(labels.get("a")).toBe("执行");
  expect(labels.get("b")).toBe("修复轮 #1");
  expect(labels.get("c")).toBe("修复轮 #2");
});

test("computeRunLabels: 执行与修复混排，各自独立计数", () => {
  const labels = computeRunLabels([
    run({ id: "e1", kind: "execution", seq: 1 }),
    run({ id: "f1", kind: "fix", seq: 2 }),
    run({ id: "e2", kind: "execution", seq: 3 }),
    run({ id: "f2", kind: "fix", seq: 4 }),
  ]);
  expect(labels.get("e1")).toBe("执行 #1");
  expect(labels.get("e2")).toBe("执行 #2");
  expect(labels.get("f1")).toBe("修复轮 #1");
  expect(labels.get("f2")).toBe("修复轮 #2");
});

test("computeRunLabels: 无 kind 列的历史数据当 execution", () => {
  const labels = computeRunLabels([run({ id: "a" }), run({ id: "b" })]);
  expect(labels.get("a")).toBe("执行 #1");
  expect(labels.get("b")).toBe("执行 #2");
});

test("runOutcome: done + pr_url + pr_number → PR #号 + 跳转（无 ✓ 符号）", () => {
  const o = runOutcome(run({ id: "a", status: "done", pr_url: "https://x/pr/9", pr_number: 9 }));
  expect(o.tone).toBe("done");
  expect(o.text).toBe("PR #9");
  expect(o.prUrl).toBe("https://x/pr/9");
});

test("runOutcome: done + pr_url 但 pr_number 缺失 → 从 url 解析号（不出现「PR PR」）", () => {
  const o = runOutcome(run({ id: "a", status: "done", pr_url: "https://github.com/o/r/pull/96" }));
  expect(o.text).toBe("PR #96");
});

test("runOutcome: done 无 pr → 已交付（无符号），无 prUrl", () => {
  const o = runOutcome(run({ id: "a", status: "done" }));
  expect(o.tone).toBe("done");
  expect(o.text).toBe("已交付");
  expect(o.prUrl).toBeUndefined();
});

test("runOutcome: failed → 失败（无 ✗ 符号）", () => {
  expect(runOutcome(run({ id: "a", status: "failed" }))).toMatchObject({ tone: "failed", text: "失败" });
});

test("runOutcome: cancelled / canceled → 已取消（无符号）", () => {
  expect(runOutcome(run({ id: "a", status: "cancelled" })).text).toBe("已取消");
  expect(runOutcome(run({ id: "a", status: "canceled" })).text).toBe("已取消");
});

test("runOutcome: 非终态按 kind 区分执行中/修复中（无符号）", () => {
  expect(runOutcome(run({ id: "a", status: "running_design", kind: "execution" })).text).toBe("执行中…");
  expect(runOutcome(run({ id: "b", status: "running_fix", kind: "fix" })).text).toBe("修复中…");
  expect(runOutcome(run({ id: "c", status: "awaiting_review", kind: "execution" })).tone).toBe("active");
});
