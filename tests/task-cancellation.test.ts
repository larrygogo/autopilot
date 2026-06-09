import { describe, it, expect, afterEach } from "bun:test";
import {
  registerRun,
  unregisterRun,
  abortRun,
  _clearRunsForTest,
} from "../src/core/task-lifecycle";
import {
  runWithTaskContext,
  getCurrentAbortSignal,
} from "../src/core/task-context";
import { Agent } from "../src/agents/agent";
import { BaseProvider } from "../src/agents/providers/base";
import type { AgentResult, RunOptions } from "../src/agents/types";
import { rmSync } from "fs";
import { join } from "path";
import { AUTOPILOT_HOME } from "../src/index";

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

describe("task-context · 注入 signal（Task 2）", () => {
  it("runWithTaskContext 带 signal 时 getCurrentAbortSignal 返回它", () => {
    const controller = new AbortController();
    runWithTaskContext(
      { taskId: "t", phase: "develop", signal: controller.signal },
      () => {
        expect(getCurrentAbortSignal()).toBe(controller.signal);
      },
    );
  });

  it("无 signal 上下文 / 无上下文时 getCurrentAbortSignal 为 undefined", () => {
    expect(getCurrentAbortSignal()).toBeUndefined();
    runWithTaskContext({ taskId: "t", phase: "develop" }, () => {
      expect(getCurrentAbortSignal()).toBeUndefined();
    });
  });
});

class CaptureProvider extends BaseProvider {
  captured: RunOptions | undefined;
  constructor() {
    super({});
  }
  async run(_prompt: string, options?: RunOptions): Promise<AgentResult> {
    this.captured = options;
    return { text: "ok" };
  }
  async close(): Promise<void> {}
}

describe("agent.run · 透传 ctx.signal（Task 3）", () => {
  const cleanupIds: string[] = [];
  afterEach(() => {
    for (const id of cleanupIds) {
      try { rmSync(join(AUTOPILOT_HOME, "runtime", "tasks", id), { recursive: true, force: true }); } catch { /* ignore */ }
    }
    cleanupIds.length = 0;
  });

  it("在带 signal 的 task-context 内调 agent.run，provider 收到该 signal", async () => {
    const provider = new CaptureProvider();
    const agent = new Agent("test", provider, { name: "test", provider: "anthropic" });
    const controller = new AbortController();
    const id = "agtcap-1";
    cleanupIds.push(id);

    await runWithTaskContext(
      { taskId: id, phase: "develop", signal: controller.signal },
      async () => {
        await agent.run("hi", { cwd: "/tmp" });
      },
    );
    expect(provider.captured?.signal).toBe(controller.signal);
  });

  it("显式传入的 signal 优先于 ctx.signal", async () => {
    const provider = new CaptureProvider();
    const agent = new Agent("test", provider, { name: "test", provider: "anthropic" });
    const ctxSignal = new AbortController().signal;
    const explicit = new AbortController().signal;
    const id = "agtcap-2";
    cleanupIds.push(id);

    await runWithTaskContext(
      { taskId: id, phase: "develop", signal: ctxSignal },
      async () => {
        await agent.run("hi", { cwd: "/tmp", signal: explicit });
      },
    );
    expect(provider.captured?.signal).toBe(explicit);
  });
});
