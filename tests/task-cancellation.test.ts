import { describe, it, expect, afterEach } from "bun:test";
import {
  registerRun,
  unregisterRun,
  abortRun,
  _clearRunsForTest,
} from "../src/core/task/lifecycle";
import { cancelTaskAction } from "../src/daemon/task-actions";
import {
  runWithTaskContext,
  getCurrentAbortSignal,
} from "../src/core/task/context";
import { Agent } from "../src/agents/agent";
import { BaseProvider } from "../src/agents/providers/base";
import type { AgentResult, RunOptions } from "../src/agents/types";
import { rmSync } from "fs";
import { join } from "path";
import { AUTOPILOT_HOME } from "../src/index";
import { Database } from "bun:sqlite";
import { _setDbForTest, initDb, createTask, getTask } from "../src/core/db";
import { runPendingMigrations } from "../src/core/migrate";
import { executePhase } from "../src/core/runner";
import * as registry from "../src/core/registry";

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

function makeLinearWorkflow(name: string, capture: (taskId: string) => void) {
  return {
    name,
    description: "取消测试工作流",
    phases: [{
      name: "develop", pending_state: "pending_develop", running_state: "running_develop",
      trigger: "start_develop", complete_trigger: "develop_complete", fail_trigger: "develop_fail",
      label: "DEV",
      func: async (taskId: string) => { capture(taskId); },
    }],
    initial_state: "pending_develop",
    terminal_states: ["done", "cancelled", "failed"],
  } as never;
}

describe("cancelTaskAction · 触发 abortRun（Task 5）", () => {
  let db: Database;
  const cleanupIds: string[] = [];

  afterEach(() => {
    _setDbForTest(null);
    try { db.close(); } catch { /* ignore */ }
    registry._clearRegistry();
    _clearRunsForTest();
    for (const id of cleanupIds) {
      try { rmSync(join(AUTOPILOT_HOME, "runtime", "tasks", id), { recursive: true, force: true }); } catch { /* ignore */ }
    }
    cleanupIds.length = 0;
  });

  it("cancel 运行中任务 → 其 in-flight controller 被 abort", async () => {
    db = new Database(":memory:");
    _setDbForTest(db);
    initDb();
    await runPendingMigrations();
    registry._clearRegistry();
    registry.register(makeLinearWorkflow("cancel_wf2", () => {}));
    const id = "cncl-1";
    cleanupIds.push(id);
    createTask({ id, title: "t", workflow: "cancel_wf2", initialStatus: "running_develop", requirementId: undefined });

    // 模拟 in-flight：手动登记 controller（真实路径由 executePhase 登记）
    const controller = registerRun(id);
    expect(controller.signal.aborted).toBe(false);

    const { to } = cancelTaskAction(id);
    expect(to).toBe("cancelled");
    expect(controller.signal.aborted).toBe(true);
  });
});

describe("executePhase catch · 取消不污染失败计数（Task 6，关键回归）", () => {
  let db: Database;
  const cleanupIds: string[] = [];

  afterEach(() => {
    _setDbForTest(null);
    try { db.close(); } catch { /* ignore */ }
    registry._clearRegistry();
    _clearRunsForTest();
    for (const id of cleanupIds) {
      try { rmSync(join(AUTOPILOT_HOME, "runtime", "tasks", id), { recursive: true, force: true }); } catch { /* ignore */ }
    }
    cleanupIds.length = 0;
  });

  it("cancel 命中 phase 执行中（abort 后抛错）→ 任务终态 cancelled，failure_count 不被污染", async () => {
    db = new Database(":memory:");
    _setDbForTest(db);
    initDb();
    await runPendingMigrations();
    registry._clearRegistry();
    const id = "cnclrun-1";
    cleanupIds.push(id);
    registry.register(makeLinearWorkflow("cancel_wf3", (taskId) => {
      // 模拟：cancel 在本 phase 执行中命中（走真实 cancelTaskAction → 转 cancelled + abortRun）
      cancelTaskAction(taskId);
      expect(getCurrentAbortSignal()?.aborted).toBe(true);
      // 模拟 agent.run 因 abort 抛错
      throw new Error("claude CLI 被取消或超时");
    }));
    createTask({ id, title: "t", workflow: "cancel_wf3", initialStatus: "running_develop", requirementId: undefined });

    await executePhase(id, "develop");

    const t = getTask(id);
    expect(t?.status).toBe("cancelled");
    // 关键：取消导致的 abort 不计失败（否则 failure_count 会被脏写、UI 误显示"正在重试"）
    expect((t?.failure_count as number | undefined) ?? 0).toBe(0);
    expect(t?.last_failure_fingerprint ?? null).toBeNull();
  });
});

describe("executePhase · 登记/注入/注销 signal（Task 4）", () => {
  let db: Database;
  const cleanupIds: string[] = [];

  afterEach(() => {
    _setDbForTest(null);
    try { db.close(); } catch { /* ignore */ }
    registry._clearRegistry();
    _clearRunsForTest();
    for (const id of cleanupIds) {
      try { rmSync(join(AUTOPILOT_HOME, "runtime", "tasks", id), { recursive: true, force: true }); } catch { /* ignore */ }
    }
    cleanupIds.length = 0;
  });

  it("phaseFn 在执行中能拿到未 abort 的 signal；executePhase 结束后 controller 被注销", async () => {
    let seen: AbortSignal | undefined;
    let seenAborted: boolean | undefined;
    db = new Database(":memory:");
    _setDbForTest(db);
    initDb();
    await runPendingMigrations();
    registry._clearRegistry();
    registry.register(makeLinearWorkflow("cancel_wf", (_taskId) => {
      seen = getCurrentAbortSignal();
      seenAborted = seen?.aborted;
    }));
    const id = "exru-1";
    cleanupIds.push(id);
    createTask({ id, title: "t", workflow: "cancel_wf", initialStatus: "running_develop", requirementId: undefined });

    await executePhase(id, "develop");

    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seenAborted).toBe(false);
    expect(abortRun(id)).toBe(false); // 已注销，找不到 controller
    expect(getTask(id)?.status).toBe("done");
  });
});
