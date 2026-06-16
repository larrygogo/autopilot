import { describe, it, expect } from "bun:test";
import {
  runWithLogContext,
  currentLogContext,
  setPhase,
  setTaskId,
  resetPhase,
} from "../src/core/logger";

// 回归：daemon 同进程并发跑多个 phase 时，旧实现用进程级全局 currentTaskId/
// currentPhaseName，导致日志窜进别的 task 的 phase-<name>.log。改 AsyncLocalStorage
// 后每个 phase 执行独立上下文，并发不串写。

describe("logger 上下文隔离（AsyncLocalStorage）", () => {
  it("两个并发上下文交错 await，taskId/phaseName 不串写", async () => {
    const seen: Record<string, Set<string>> = { a: new Set(), b: new Set() };

    async function run(taskId: string, phase: string, slot: "a" | "b", step: number) {
      return runWithLogContext({ taskId, phaseName: phase }, async () => {
        for (let i = 0; i < 6; i++) {
          await new Promise((r) => setTimeout(r, step));
          const ctx = currentLogContext();
          seen[slot].add(`${ctx.taskId}/${ctx.phaseName}`);
        }
        return currentLogContext();
      });
    }

    const [ca, cb] = await Promise.all([
      run("task-a", "design", "a", 3),
      run("task-b", "review", "b", 2),
    ]);

    expect(ca.taskId).toBe("task-a");
    expect(ca.phaseName).toBe("design");
    expect(cb.taskId).toBe("task-b");
    expect(cb.phaseName).toBe("review");
    // 交错执行全程，各自上下文始终只看到自己的——没串到对方
    expect([...seen.a]).toEqual(["task-a/design"]);
    expect([...seen.b]).toEqual(["task-b/review"]);
  });

  it("上下文内 setPhase/setTaskId 只改本 store，不污染并发上下文", async () => {
    async function run(initTask: string, newPhase: string) {
      return runWithLogContext({ taskId: initTask, phaseName: "init" }, async () => {
        await new Promise((r) => setTimeout(r, 2));
        setPhase(newPhase, newPhase.toUpperCase());
        await new Promise((r) => setTimeout(r, 2));
        return currentLogContext();
      });
    }
    const [a, b] = await Promise.all([run("t1", "develop"), run("t2", "code_review")]);
    expect(a).toMatchObject({ taskId: "t1", phaseName: "develop", phaseTag: "DEVELOP" });
    expect(b).toMatchObject({ taskId: "t2", phaseName: "code_review", phaseTag: "CODE_REVIEW" });
  });

  it("无 als 上下文时回退进程级全局（非 phase 路径行为不变）", () => {
    resetPhase();
    setTaskId("global-task");
    setPhase("clarify", "CLARIFY");
    const ctx = currentLogContext();
    expect(ctx).toMatchObject({ taskId: "global-task", phaseName: "clarify", phaseTag: "CLARIFY" });
    resetPhase();
    expect(currentLogContext().phaseTag).toBe("SYSTEM");
  });
});
