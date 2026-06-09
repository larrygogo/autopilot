# A1 阶段 1：per-task 取消令牌（关闭 CONC-09）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给每个正在执行的 task run 一个进程内 AbortController，让 cancel 能真正打断 in-flight phase（终止 agent 子进程），并保证取消导致的 abort 错误不污染失败计数。

**Architecture:** 新增 `src/core/task-lifecycle.ts`（per-task controller 登记处，纯机制零业务知识）。`executePhase` 入口登记 controller、把其 `signal` 经 `task-context` 的 AsyncLocalStorage 注入；`Agent.run` 从 task-context 兜底取 signal 透传给 provider（provider 层 signal→SIGTERM 已就位）。`cancelTaskAction` 触发 `abortRun`。`executePhase` 的 catch 顶部加守卫：task 已 cancelled / signal 已 abort 时静默退出，不计失败、不 forceTransition。

**Tech Stack:** Bun + TypeScript strict；测试 `bun:test`；现有 `RunOptions.signal?: AbortSignal` 与 anthropic provider 的 `signal→proc.kill()` 已是一等公民，本阶段只「接线」。

**范围边界（YAGNI）：** 仅覆盖**线性 executePhase 路径**。并行块（`executeParallelGroup`，在 parallel 检测处提前 return、不经线性 register 点）本阶段不接 controller——dev 工作流是线性的，并行写本就不支持（共用沙盒不隔离子工作树），cancel 并行组不 abort 子阶段作为**已知限制**记录，留后续。设计稿 §4 的阶段 2（cancelTask 收口级联）/ 阶段 3（submit_pr 检查点）不在本计划。

设计依据：`docs/superpowers/specs/2026-06-09-task-lifecycle-coordinator-design.md`。

---

## 文件结构

- **新建** `src/core/task-lifecycle.ts` — per-task AbortController 登记处。职责单一：建/注销/触发取消令牌。零工作流知识。
- **改** `src/core/task-context.ts` — `TaskContext` 加 `signal?: AbortSignal` + `getCurrentAbortSignal()`。
- **改** `src/agents/agent.ts` — `Agent.run` 把 `ctx.signal` 注入 `runOptions`。
- **改** `src/core/runner.ts` — `executePhase` 登记/注销 controller + 注入 signal 进 ctx + catch 守卫。
- **改** `src/daemon/task-actions.ts` — `cancelTaskAction` 调 `abortRun`。
- **新建** `tests/task-cancellation.test.ts` — 全阶段测试。

---

## Task 1：task-lifecycle.ts 取消令牌登记处

**Files:**
- Create: `src/core/task-lifecycle.ts`
- Test: `tests/task-cancellation.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `tests/task-cancellation.test.ts`：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/task-cancellation.test.ts`
Expected: FAIL — 无法解析 `../src/core/task-lifecycle`（模块不存在）。

- [ ] **Step 3: 写最小实现**

新建 `src/core/task-lifecycle.ts`：

```ts
// 任务执行生命周期：per-task 取消令牌登记处（CONC-09）。
//
// 每个正在执行的 task run 一个进程内 AbortController：executePhase 入口 registerRun、
// finally unregisterRun；cancel 动作经 abortRun 触发；signal 经 task-context 注入 agent.run，
// 由 provider 转成对子进程的 SIGTERM。
//
// key = taskId：executePhase 入口 acquireLock 保证同一 task 同时只有一个 phase 在跑
//（并行块是单 executeParallelGroup 调用内的 Promise.allSettled，仍在同一把锁下），故一对一。
//
// 本模块是 src/core/ 纯机制层，零工作流知识。

const _controllers = new Map<string, AbortController>();

/** 登记一个新 run，返回其 AbortController。若已存在旧 controller（不该发生）先 abort 防泄漏。 */
export function registerRun(taskId: string): AbortController {
  const existing = _controllers.get(taskId);
  if (existing) existing.abort();
  const controller = new AbortController();
  _controllers.set(taskId, controller);
  return controller;
}

/** 注销 run（executePhase finally 调）。对未登记的 taskId 静默。 */
export function unregisterRun(taskId: string): void {
  _controllers.delete(taskId);
}

/** 触发某 task 的 in-flight 取消。返回是否真有 in-flight controller 被 abort。 */
export function abortRun(taskId: string): boolean {
  const controller = _controllers.get(taskId);
  if (!controller) return false;
  controller.abort();
  return true;
}

/** 测试用：清空所有登记。 */
export function _clearRunsForTest(): void {
  _controllers.clear();
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/task-cancellation.test.ts`
Expected: PASS（3 个用例）。

- [ ] **Step 5: 提交**

```bash
git add src/core/task-lifecycle.ts tests/task-cancellation.test.ts
git commit -m "feat(core): A1-P1 task-lifecycle per-task 取消令牌登记处"
```

---

## Task 2：task-context 注入 signal

**Files:**
- Modify: `src/core/task-context.ts`
- Test: `tests/task-cancellation.test.ts`

- [ ] **Step 1: 追加失败测试**

在 `tests/task-cancellation.test.ts` 顶部 import 补 `runWithTaskContext` / `getCurrentAbortSignal`：

```ts
import {
  runWithTaskContext,
  getCurrentAbortSignal,
} from "../src/core/task-context";
```

追加 describe：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/task-cancellation.test.ts`
Expected: FAIL — `getCurrentAbortSignal` 不是导出函数 / `signal` 不是 `TaskContext` 合法字段（类型报错或运行时 undefined）。

- [ ] **Step 3: 写最小实现**

`src/core/task-context.ts`，在 `TaskContext` 接口 `sandboxDir?: string;` 之后加字段：

```ts
  /**
   * 本次 phase 的取消令牌（per-task，CONC-09）。runner 注入 registerRun 返回的 controller.signal；
   * Agent.run 兜底取它透传给 provider（provider 转 SIGTERM），phaseFn 也可经 getCurrentAbortSignal 协作检查。
   */
  signal?: AbortSignal;
```

并在 `getCurrentSandboxDir` 之后加：

```ts
/** 当前 phase 的取消令牌（无则 undefined）。 */
export function getCurrentAbortSignal(): AbortSignal | undefined {
  return als.getStore()?.signal;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/task-cancellation.test.ts`
Expected: PASS（含 Task 1 共 5 用例）。

- [ ] **Step 5: 提交**

```bash
git add src/core/task-context.ts tests/task-cancellation.test.ts
git commit -m "feat(core): A1-P1 task-context 注入 per-task signal + getCurrentAbortSignal"
```

---

## Task 3：Agent.run 透传 ctx.signal 给 provider

**Files:**
- Modify: `src/agents/agent.ts:22-24`
- Test: `tests/task-cancellation.test.ts`

- [ ] **Step 1: 追加失败测试**

`tests/task-cancellation.test.ts` 顶部补 import：

```ts
import { Agent } from "../src/agents/agent";
import { BaseProvider } from "../src/agents/providers/base";
import type { AgentResult, RunOptions } from "../src/agents/types";
import { rmSync } from "fs";
import { join } from "path";
import { AUTOPILOT_HOME } from "../src/index";
```

追加 describe（fake provider 捕获 runOptions，验证 ctx.signal 被透传）：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/task-cancellation.test.ts`
Expected: FAIL — `provider.captured?.signal` 为 `undefined`（当前 `Agent.run` 不注入 ctx.signal）。

- [ ] **Step 3: 写最小实现**

`src/agents/agent.ts`，把 `run` 里构建 `runOptions` 的三行（当前 22-24）：

```ts
    const runOptions: RunOptions | undefined = ctx
      ? { ...options, env: { ...options?.env, AUTOPILOT_HOME: getTaskAgentHome(ctx.taskId) } }
      : options;
```

改为：

```ts
    // signal：显式传入优先，否则用 task-context 注入的 per-task 取消令牌（CONC-09）。
    // 注入点放在 Agent.run 而非各 phaseFn —— 所有走 agent.run 的 phase（含 prompt-runner 零代码模式）
    // 都自动获得可中断能力，无需逐个 phaseFn 改造。
    const runOptions: RunOptions | undefined = ctx
      ? { ...options, signal: options?.signal ?? ctx.signal, env: { ...options?.env, AUTOPILOT_HOME: getTaskAgentHome(ctx.taskId) } }
      : options;
```

（`ctx` 为空时走 `: options` 原样保留其自带 signal，无需改。）

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/task-cancellation.test.ts`
Expected: PASS（含前序共 7 用例）。

- [ ] **Step 5: 提交**

```bash
git add src/agents/agent.ts tests/task-cancellation.test.ts
git commit -m "feat(agent): A1-P1 Agent.run 从 task-context 兜底注入 signal 给 provider"
```

---

## Task 4：executePhase 登记/注销 controller + 注入 signal

**Files:**
- Modify: `src/core/runner.ts`（顶部 import；executePhase 入口声明 + register；runWithTaskContext 注入 signal；finally unregister）
- Test: `tests/task-cancellation.test.ts`

- [ ] **Step 1: 追加失败测试**

`tests/task-cancellation.test.ts` 顶部补 import（DB/registry/runner 测试夹具，仿 `tests/task-sandbox-shared.test.ts`）：

```ts
import { Database } from "bun:sqlite";
import { _setDbForTest, initDb, createTask, getTask } from "../src/core/db";
import { runPendingMigrations } from "../src/core/migrate";
import { executePhase } from "../src/core/runner";
import * as registry from "../src/core/registry";
```

追加 describe（注册一个最简工作流，phaseFn 断言能拿到未 abort 的 signal；executePhase 后 controller 注销）：

```ts
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

  async function setup(workflowName: string, wf: unknown) {
    db = new Database(":memory:");
    _setDbForTest(db);
    initDb();
    await runPendingMigrations();
    registry._clearRegistry();
    registry.register(wf as never);
  }

  it("phaseFn 在执行中能拿到未 abort 的 signal；executePhase 结束后 controller 被注销", async () => {
    let seen: AbortSignal | undefined;
    let seenAborted: boolean | undefined;
    await setup("cancel_wf", makeLinearWorkflow("cancel_wf", () => {
      seen = getCurrentAbortSignal();
      seenAborted = seen?.aborted;
    }));
    const id = "exru-1";
    cleanupIds.push(id);
    createTask({ id, title: "t", workflow: "cancel_wf", initialStatus: "running_develop", requirementId: undefined });

    await executePhase(id, "develop");

    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seenAborted).toBe(false);
    // 注销验证：此时再 abortRun 应找不到 controller
    expect(abortRun(id)).toBe(false);
    // phase 正常完成 → 推进终态 done
    expect(getTask(id)?.status).toBe("done");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/task-cancellation.test.ts`
Expected: FAIL — `seen` 为 `undefined`（executePhase 尚未把 signal 注入 ctx）。

- [ ] **Step 3: 写实现**

`src/core/runner.ts` 顶部 import 区加：

```ts
import { registerRun, unregisterRun } from "./task-lifecycle";
```

在 `executePhase` 函数体开头（当前 `let phaseEventId: number | null = null;` 一行旁）加 controller 声明（`AbortController` 是全局类型，无需 import）：

```ts
  let phaseEventId: number | null = null;
  let controller: AbortController | null = null;
```

把当前线性路径的 `runWithTaskContext`（执行 phaseFn 处，当前约 runner.ts:162-166）：

```ts
    try {
      await runWithTaskContext(
        { taskId, phase, sandboxDir: getTaskSandbox(taskId) },
        async () => { await phaseFn(taskId); },
      );
    } finally {
      clearInterval(heartbeat);
    }
```

改为（在 try 前 register，把 controller.signal 注入 ctx）：

```ts
    controller = registerRun(taskId);
    try {
      await runWithTaskContext(
        { taskId, phase, sandboxDir: getTaskSandbox(taskId), signal: controller.signal },
        async () => { await phaseFn(taskId); },
      );
    } finally {
      clearInterval(heartbeat);
    }
```

在 `executePhase` 的 `finally` 块（当前约 runner.ts:329 `releaseLock(taskId);` 一行之后）加注销：

```ts
    resetPhase();
    releaseLock(taskId);
    unregisterRun(taskId);
```

> `controller` 变量供 Task 5 的 catch 守卫使用；本任务先声明、register 时赋值，catch 守卫在 Task 5 加。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/task-cancellation.test.ts`
Expected: PASS（含前序共 8 用例）。

- [ ] **Step 5: typecheck + 提交**

```bash
bun run typecheck
git add src/core/runner.ts tests/task-cancellation.test.ts
git commit -m "feat(core): A1-P1 executePhase 登记取消令牌并注入 signal 进 task-context"
```

---

## Task 5：cancelTaskAction 触发 abortRun

**Files:**
- Modify: `src/daemon/task-actions.ts`（import + cancelTaskAction body）
- Test: `tests/task-cancellation.test.ts`

- [ ] **Step 1: 追加失败测试**

`tests/task-cancellation.test.ts` 顶部补 import：

```ts
import { cancelTaskAction } from "../src/daemon/task-actions";
```

追加 describe（手动 registerRun 模拟 in-flight，cancelTaskAction 应 abort 该 controller）：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/task-cancellation.test.ts`
Expected: FAIL — `controller.signal.aborted` 仍为 `false`（cancelTaskAction 未调 abortRun）。

- [ ] **Step 3: 写实现**

`src/daemon/task-actions.ts` 顶部 import 区加：

```ts
import { abortRun } from "../core/task-lifecycle";
```

`cancelTaskAction` 里，在 `transition(...)` 之后、`closeOpenPhaseEvents(taskId)` 之前加一行（当前约 task-actions.ts:63-65）：

```ts
  const [from, to] = transition(taskId, "cancel", { transitions, note: "API cancel" });
  // 打断 in-flight phase 的 agent 子进程（CONC-09）：cancel 不再只是改状态，
  // 经 task-lifecycle 触发 AbortSignal → provider SIGTERM。无 in-flight 时 no-op。
  abortRun(taskId);
  // 关闭进行中的 phase event，避免取消后留下永远 running 的僵尸
  closeOpenPhaseEvents(taskId);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/task-cancellation.test.ts`
Expected: PASS（含前序共 9 用例）。

- [ ] **Step 5: 提交**

```bash
git add src/daemon/task-actions.ts tests/task-cancellation.test.ts
git commit -m "feat(daemon): A1-P1 cancelTaskAction 触发 abortRun 打断 in-flight phase"
```

---

## Task 6：catch 守卫——取消导致的 abort 不污染失败计数（关键回归点）

**Files:**
- Modify: `src/core/runner.ts`（executePhase catch 块顶部加守卫）
- Test: `tests/task-cancellation.test.ts`

> 这是设计稿 §5「最危险回归」+ 开放问题 #1 的钉死测试。当前 catch 把任何非 InvalidTransitionError 当 phase 失败：累加 failure_count、emit phase:error、可能 forceTransition→failed（被终态吞但计数已脏）。cancel 触发 abort 会让 phaseFn（经 agent.run）抛错落进 catch。守卫确保此时静默退出。

- [ ] **Step 1: 追加失败测试**

`tests/task-cancellation.test.ts` 追加 describe（phaseFn 在执行中 cancel 自己再抛错，模拟「cancel 命中 phase 执行中、agent.run 因 abort 抛错」）：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/task-cancellation.test.ts`
Expected: FAIL — `failure_count` 为 `1`（catch 的失败计数分支把 abort 错误当成 phase 失败累加了）。

- [ ] **Step 3: 写实现**

`src/core/runner.ts` 的 `executePhase` catch 块（当前约 runner.ts:264 `} catch (err) {`）。当前结构：

```ts
  } catch (err) {
    if (err instanceof InvalidTransitionError) {
      log.warn("InvalidTransitionError [task=%s phase=%s]: %s", taskId, phase, err.message);
    } else {
      const errMsg = err instanceof Error ? err.stack ?? err.message : String(err);
      // ... 失败计数 / forceTransition ...
    }
  } finally {
```

在 catch 第一行加守卫分支（放在 InvalidTransitionError 判断之前）：

```ts
  } catch (err) {
    // 取消导致的中止：task 已 cancelled 终态 / signal 已 abort → 静默退出，不计失败、不 forceTransition。
    // 否则 abort 错误会落进下面的失败计数分支，污染 failure_count（UI 误显示"正在重试"）并 emit
    // 误导性 phase:error（CONC-09 / 设计稿 §5 最危险回归）。
    if (controller?.signal.aborted || getTask(taskId)?.status === "cancelled") {
      log.info("阶段因取消中止，跳过失败计数 [task=%s phase=%s]", taskId, phase);
    } else if (err instanceof InvalidTransitionError) {
      log.warn("InvalidTransitionError [task=%s phase=%s]: %s", taskId, phase, err.message);
    } else {
      const errMsg = err instanceof Error ? err.stack ?? err.message : String(err);
      // ... 原失败计数 / forceTransition 不变 ...
    }
  } finally {
```

> 仅新增首个 `if (controller?.signal.aborted || ...)` 分支并把原 `if (err instanceof InvalidTransitionError)` 降为 `else if`。原失败计数 `else` 块整体不动。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/task-cancellation.test.ts`
Expected: PASS（含前序共 10 用例）。

- [ ] **Step 5: 全量验证 + 提交**

```bash
bun run typecheck
bun test
git add src/core/runner.ts tests/task-cancellation.test.ts
git commit -m "fix(core): A1-P1 catch 守卫——取消导致的 abort 不污染失败计数（关闭 CONC-09）"
```

Expected: `bun run typecheck` 无输出（通过）；`bun test` 全绿（1002+ pass，含新增 10 用例）。

---

## 收尾

全部 6 task 完成后：
- CONC-09 关闭：cancel 真正打断 in-flight phase 的 agent 子进程，且不污染失败计数。
- 用 superpowers:finishing-a-development-branch 收口（已在 main 直接开发的话则验证 + 推送）。

**遗留（不在本阶段，已记录于 backlog/spec）：**
- 并行块（executeParallelGroup）cancel 不 abort 子阶段——已知限制，dev 工作流线性、并行写不支持。
- 设计稿阶段 2（cancelTask 收口 4 处级联）、阶段 3（submit_pr push 前协作检查点）、开放问题 #2（OpenAI/Google provider abort 完整性核实）。

## Self-Review

**1. Spec coverage（对照设计稿 §2/§4 阶段 1 + §5）：**
- §2 数据结构 `_controllers` Map → Task 1 ✅
- §2 signal 贯穿（task-context + Agent.run 注入点）→ Task 2 + Task 3 ✅
- §2 生命周期（建 register / 注销 unregister）→ Task 4 ✅
- §4 阶段 1「cancelTaskAction 加 abortRun」→ Task 5 ✅
- §5 最危险回归「abort 不污染 failure_count」+ 开放问题 #1 → Task 6 ✅（TDD 红先钉）
- 范围内未覆盖项：executeParallelGroup（已显式划为已知限制，YAGNI）。

**2. Placeholder scan：** 无 TBD/TODO/"类似 TaskN"；每个代码步给完整真实代码（基于实际读取的 `RunOptions`/`BaseProvider`/`AgentResult`/`AgentConfig`/`Agent.run`/`cancelTaskAction`/`executePhase` 签名）。

**3. Type consistency：** API 名跨 task 一致——`registerRun`(返回 `AbortController`)/`unregisterRun`/`abortRun`/`_clearRunsForTest`（Task 1 定义，Task 4/5/6 复用）；`getCurrentAbortSignal`/`TaskContext.signal`（Task 2 定义，Task 3/4/6 复用）；`controller` 局部变量（Task 4 声明赋值，Task 6 catch 守卫复用）。测试夹具 `makeLinearWorkflow` Task 4 定义、Task 5/6 复用。
