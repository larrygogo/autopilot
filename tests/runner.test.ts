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
  "    parallel_group TEXT DEFAULT NULL",
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
