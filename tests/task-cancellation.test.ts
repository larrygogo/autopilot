import { describe, it, expect, afterEach } from "bun:test";
import {
  registerRun,
  unregisterRun,
  abortRun,
  _clearRunsForTest,
} from "../src/core/task-lifecycle";

afterEach(() => {
  _clearRunsForTest();
});

describe("task-lifecycle · 取消令牌登记处（Task 1）", () => {
  it("registerRun 返回未 abort 的 controller，abortRun 触发它，unregisterRun 注销", () => {
    const c = registerRun("t1");
    expect(c.signal.aborted).toBe(false);

    const hit = abortRun("t1");
    expect(hit).toBe(true);
    expect(c.signal.aborted).toBe(true);

    unregisterRun("t1");
    // 注销后再 abort 找不到 controller，返回 false（不抛）
    expect(abortRun("t1")).toBe(false);
  });

  it("abortRun 对未登记的 task 返回 false 不抛", () => {
    expect(abortRun("nope")).toBe(false);
  });

  it("registerRun 覆盖旧 controller 前先 abort 旧的，防泄漏", () => {
    const old = registerRun("t2");
    const fresh = registerRun("t2"); // 不该发生（锁保证），但防御
    expect(old.signal.aborted).toBe(true);
    expect(fresh.signal.aborted).toBe(false);
  });
});
