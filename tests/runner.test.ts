import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";

// ──────────────────────────────────────────────
// 测试辅助：创建内存 DB 并注入
// ──────────────────────────────────────────────

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS tasks (",
  "    id TEXT PRIMARY KEY,",
  "    title TEXT NOT NULL,",
  "    workflow TEXT NOT NULL,",
  "    status TEXT NOT NULL,",
  "    failure_count INTEGER DEFAULT 0,",
  "    channel TEXT DEFAULT 'log',",
  "    notify_target TEXT,",
  "    extra TEXT DEFAULT '{}',",
  "    created_at TEXT NOT NULL,",
  "    updated_at TEXT NOT NULL,",
  "    started_at TEXT,",
  "    parent_task_id TEXT DEFAULT NULL,",
  "    parallel_index INTEGER DEFAULT NULL,",
  "    parallel_group TEXT DEFAULT NULL,",
  "    requirement_id TEXT DEFAULT NULL",
  ");",
  "",
  "CREATE TABLE IF NOT EXISTS task_logs (",
  "    id INTEGER PRIMARY KEY AUTOINCREMENT,",
  "    task_id TEXT NOT NULL,",
  "    from_status TEXT,",
  "    to_status TEXT NOT NULL,",
  "    trigger_name TEXT,",
  "    note TEXT,",
  "    created_at TEXT NOT NULL,",
  "    FOREIGN KEY (task_id) REFERENCES tasks(id)",
  ");",
  "",
  "CREATE TABLE IF NOT EXISTS task_phase_events (",
  "    id INTEGER PRIMARY KEY AUTOINCREMENT,",
  "    task_id TEXT NOT NULL,",
  "    phase TEXT NOT NULL,",
  "    status TEXT NOT NULL,",
  "    started_at INTEGER NOT NULL,",
  "    ended_at INTEGER,",
  "    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE",
  ");",
].join("\n");

// ──────────────────────────────────────────────
// 测试工作流定义
// ──────────────────────────────────────────────

function makeTestWorkflow(phaseFn: (taskId: string) => Promise<void>) {
  return {
    name: "test_wf",
    description: "测试工作流",
    phases: [
      {
        name: "step1",
        pending_state: "pending_step1",
        running_state: "running_step1",
        trigger: "start_step1",
        complete_trigger: "step1_complete",
        fail_trigger: "step1_fail",
        label: "STEP1",
        func: phaseFn,
      },
    ],
    initial_state: "pending_step1",
    terminal_states: ["done", "cancelled"],
  };
}

// ──────────────────────────────────────────────
// 测试套件
// ──────────────────────────────────────────────

describe("runner - executePhase", () => {
  let sqlite: Database;
  let dbModule: typeof import("../src/core/db");
  let registryModule: typeof import("../src/core/registry");
  let runnerModule: typeof import("../src/core/runner");

  beforeEach(async () => {
    // 1. 创建内存 DB
    sqlite = new Database(":memory:");
    sqlite.run("PRAGMA journal_mode=WAL");
    sqlite.run("PRAGMA foreign_keys=ON");
    sqlite.exec(SCHEMA);

    // 2. 注入内存 DB
    dbModule = await import("../src/core/db");
    (dbModule as any)._setDbForTest(sqlite);
    dbModule.initDb();

    // 3. 获取其他模块引用
    registryModule = await import("../src/core/registry");
    runnerModule = await import("../src/core/runner");

    // 4. 清空注册表
    registryModule._clearRegistry();
  });

  afterEach(() => {
    registryModule._clearRegistry();
    (dbModule as any)._setDbForTest(null);
    sqlite.close();
  });

  it("executePhase 应执行阶段函数并完成状态转换", async () => {
    let phaseCalled = false;
    let calledWithTaskId = "";

    const phaseFn = async (taskId: string) => {
      phaseCalled = true;
      calledWithTaskId = taskId;
    };

    // 注册工作流
    registryModule.register(makeTestWorkflow(phaseFn) as any);

    // 创建任务（初始状态 pending_step1）
    dbModule.createTask({
      id: "task-run-001",
      title: "执行测试",
      workflow: "test_wf",
      initialStatus: "pending_step1",
    });

    // 执行阶段
    await runnerModule.executePhase("task-run-001", "step1");

    // 验证阶段函数被调用
    expect(phaseCalled).toBe(true);
    expect(calledWithTaskId).toBe("task-run-001");

    // 阶段函数正常返回后，runner 自动触发 complete_trigger 推进状态机。
    // makeTestWorkflow 只有 step1 一个阶段，complete 后应进入终态 done。
    const task = dbModule.getTask("task-run-001");
    expect(task).not.toBeNull();
    expect(task!.status).toBe("done");
  });

  it("executePhase 在任务不存在时应安全跳过（不报错）", async () => {
    const phaseFn = async (_taskId: string) => {};
    registryModule.register(makeTestWorkflow(phaseFn) as any);

    // 不创建任务，直接执行
    let threw = false;
    try {
      await runnerModule.executePhase("nonexistent-task-999", "step1");
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
  });

  it("阶段函数 throw 时 failure_count 累计，达 5 次后强制转 cancelled", async () => {
    const phaseFn = async (_taskId: string) => {
      throw new Error("deterministic failure (模拟 sygvsxmy 缺 requirement_id 场景)");
    };
    registryModule.register(makeTestWorkflow(phaseFn) as any);

    dbModule.createTask({
      id: "task-fail-loop-001",
      title: "失败计数测试",
      workflow: "test_wf",
      initialStatus: "pending_step1",
    });

    // 连跑 4 次：failure_count 累计 1→4，但状态机不该转 cancelled
    for (let i = 0; i < 4; i++) {
      await runnerModule.executePhase("task-fail-loop-001", "step1");
      // 状态留在 running_step1（runner 没主动转 failed）；重置回 pending 模拟 watcher 弹回
      sqlite.run("UPDATE tasks SET status='pending_step1' WHERE id='task-fail-loop-001'");
    }
    const mid = dbModule.getTask("task-fail-loop-001");
    expect(mid!.failure_count).toBe(4);
    expect(mid!.status).toBe("pending_step1");

    // 第 5 次：达阈值 → forceTransition cancelled
    await runnerModule.executePhase("task-fail-loop-001", "step1");
    const after = dbModule.getTask("task-fail-loop-001");
    expect(after!.failure_count).toBe(5);
    expect(after!.status).toBe("cancelled");
  });

  it("确定性失败：连续相同错误指纹，第 2 次即 cancelled（不等 failure_count 到 5）", async () => {
    const phaseFn = async (_taskId: string) => {
      throw new Error("Cannot find module '/repo/x.ts'");
    };
    registryModule.register(makeTestWorkflow(phaseFn) as any);
    dbModule.createTask({
      id: "task-det-001",
      title: "确定性失败",
      workflow: "test_wf",
      initialStatus: "pending_step1",
    });

    // 第 1 次：记指纹，留 running，不立即 cancel
    await runnerModule.executePhase("task-det-001", "step1");
    const after1 = dbModule.getTask("task-det-001");
    expect(after1!.failure_count).toBe(1);
    expect(after1!.status).not.toBe("cancelled");
    sqlite.run("UPDATE tasks SET status='pending_step1' WHERE id='task-det-001'");

    // 第 2 次：相同指纹 → 判定确定性 → 立即 cancelled（远未到 5）
    await runnerModule.executePhase("task-det-001", "step1");
    const after2 = dbModule.getTask("task-det-001");
    expect(after2!.status).toBe("cancelled");
    expect(after2!.failure_count).toBe(2);
  });

  it("失败指纹绑定 phase 前缀：跨阶段相同错误不互相误判", async () => {
    const phaseFn = async (_taskId: string) => {
      throw new Error("git 命令失败：git checkout main");
    };
    registryModule.register(makeTestWorkflow(phaseFn) as any);
    dbModule.createTask({
      id: "task-fp-phase-001",
      title: "指纹绑定 phase",
      workflow: "test_wf",
      initialStatus: "pending_step1",
    });
    await runnerModule.executePhase("task-fp-phase-001", "step1");
    const t = dbModule.getTask("task-fp-phase-001");
    // 指纹必须带 phase 前缀，否则不同阶段的相同 git 错误会互相误判为确定性失败
    expect(t!["last_failure_fingerprint"]).toContain("step1::");
  });

  it("偶发失败：连续不同错误指纹不触发快速止损，留给 watcher 重试", async () => {
    const msgs = ["network timeout", "disk quota exceeded", "upstream 503", "connection reset"];
    let i = 0;
    const phaseFn = async (_taskId: string) => {
      throw new Error(msgs[i++ % msgs.length]);
    };
    registryModule.register(makeTestWorkflow(phaseFn) as any);
    dbModule.createTask({
      id: "task-flaky-001",
      title: "偶发失败",
      workflow: "test_wf",
      initialStatus: "pending_step1",
    });

    for (let n = 0; n < 4; n++) {
      await runnerModule.executePhase("task-flaky-001", "step1");
      // 不同错误不快速止损，仍留 running（手动弹回模拟 watcher）
      expect(dbModule.getTask("task-flaky-001")!.status).not.toBe("cancelled");
      sqlite.run("UPDATE tasks SET status='pending_step1' WHERE id='task-flaky-001'");
    }
    expect(dbModule.getTask("task-flaky-001")!.failure_count).toBe(4);
  });

  it("指纹归一化：错误仅路径/行号不同（语义同一确定性失败）→ 判等 → 第 2 次 cancelled", async () => {
    const errs = [
      "Cannot find module '/a/b/c.ts' at line 31",
      "Cannot find module '/x/y/z.ts' at line 99",
    ];
    let i = 0;
    const phaseFn = async (_taskId: string) => {
      throw new Error(errs[i++]);
    };
    registryModule.register(makeTestWorkflow(phaseFn) as any);
    dbModule.createTask({
      id: "task-norm-001",
      title: "归一化",
      workflow: "test_wf",
      initialStatus: "pending_step1",
    });

    await runnerModule.executePhase("task-norm-001", "step1");
    sqlite.run("UPDATE tasks SET status='pending_step1' WHERE id='task-norm-001'");
    await runnerModule.executePhase("task-norm-001", "step1");
    expect(dbModule.getTask("task-norm-001")!.status).toBe("cancelled");
  });

  it("resetTaskForRerun：复用同 id 重置——状态回首阶段、failure_count/指纹/dangling 清空、重跑首阶段", async () => {
    const taskFactory = await import("../src/core/task-factory");
    let calls = 0;
    const phaseFn = async (_taskId: string) => { calls++; };
    registryModule.register(makeTestWorkflow(phaseFn) as any);
    dbModule.createTask({
      id: "task-rerun-001",
      title: "重跑复用",
      workflow: "test_wf",
      initialStatus: "pending_step1",
    });
    // 模拟上一轮失败残留：终态 + 失败计数 + 指纹 + dangling
    sqlite.run("UPDATE tasks SET status='cancelled', failure_count=3 WHERE id='task-rerun-001'");
    dbModule.updateTask("task-rerun-001", { last_failure_fingerprint: "step1::boom", dangling: true });

    taskFactory.resetTaskForRerun("task-rerun-001");
    await new Promise((r) => setImmediate(r)); // 等 executePhase 异步跑首阶段

    const t = dbModule.getTask("task-rerun-001");
    expect(t!.failure_count).toBe(0);
    expect(t!["last_failure_fingerprint"]).toBeFalsy();
    expect(t!["dangling"]).toBeFalsy();
    expect(t!.status).not.toBe("cancelled"); // 已重置离开终态、重跑了首阶段
    expect(calls).toBeGreaterThan(0);
  });

  it("executePhase 重复调用时锁保护防止双重执行", async () => {
    let callCount = 0;
    // 阶段函数引入延迟，模拟耗时操作
    const phaseFn = async (_taskId: string) => {
      callCount++;
      // 让出控制权，使第二次调用有机会竞争锁
      await new Promise<void>((resolve) => setImmediate(resolve));
    };

    registryModule.register(makeTestWorkflow(phaseFn) as any);

    dbModule.createTask({
      id: "task-lock-001",
      title: "锁测试",
      workflow: "test_wf",
      initialStatus: "pending_step1",
    });

    // 并发发起两次执行
    await Promise.all([
      runnerModule.executePhase("task-lock-001", "step1"),
      runnerModule.executePhase("task-lock-001", "step1"),
    ]);

    // 由于锁保护，阶段函数只应被调用一次：第一次获取锁成功执行，第二次获取锁失败直接跳过
    expect(callCount).toBe(1);
  });
});
