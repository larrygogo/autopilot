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

function makeTestWorkflowWithAwaitReview() {
  return {
    name: "test_wf",
    description: "测试工作流 with await_review",
    phases: [
      {
        name: "step1",
        pending_state: "pending_step1",
        running_state: "running_step1",
        trigger: "start_step1",
        complete_trigger: "step1_complete",
        fail_trigger: "step1_fail",
        label: "STEP1",
        func: async (_taskId: string) => {},
      },
      {
        name: "await_review",
        pending_state: "pending_await_review",
        running_state: "running_await_review",
        trigger: "start_await_review",
        complete_trigger: "review_complete",
        fail_trigger: "review_fail",
        label: "AWAIT_REVIEW",
        func: async (_taskId: string) => {},
      },
    ],
    initial_state: "pending_step1",
    terminal_states: ["done", "cancelled"],
  };
}

// ──────────────────────────────────────────────
// 测试套件
// ──────────────────────────────────────────────

describe("watcher - checkStuckTasks", () => {
  let sqlite: Database;
  let dbModule: typeof import("../src/core/db");
  let registryModule: typeof import("../src/core/registry");
  let watcherModule: typeof import("../src/core/watcher");
  let infraModule: typeof import("../src/core/infra");

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
    watcherModule = await import("../src/core/watcher");
    infraModule = await import("../src/core/infra");

    // 4. 清空注册表
    registryModule._clearRegistry();

    // 5. 清除 watcher 内部的恢复记录
    watcherModule._clearRecoveryHistory();
  });

  afterEach(() => {
    registryModule._clearRegistry();
    watcherModule._clearRecoveryHistory();
    (dbModule as any)._setDbForTest(null);
    sqlite.close();
  });

  it("running_await_review 状态不被判作卡死", () => {
    // 注册工作流
    registryModule.register(makeTestWorkflowWithAwaitReview() as any);

    // 创建任务，状态为 running_await_review，updated_at 为 30 分钟前
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    dbModule.createTask({
      id: "task-await-review-001",
      title: "长挂起任务",
      workflow: "test_wf",
      initialStatus: "running_await_review",
    });

    // 手动修改 updated_at 为 30 分钟前（模拟长时间未更新）
    sqlite.run(
      "UPDATE tasks SET updated_at = ? WHERE id = ?",
      [thirtyMinutesAgo, "task-await-review-001"]
    );

    // 获取初始状态
    const taskBefore = dbModule.getTask("task-await-review-001");
    expect(taskBefore?.status).toBe("running_await_review");

    // 调用 checkStuckTasks（timeout = 600 秒，即 10 分钟）
    // 由于 updated_at 距今 30 分钟，一般会被认为卡死，但由于是 await_review，应被跳过
    watcherModule.checkStuckTasks(600);

    // 验证任务状态未改变（没被强制转换）
    const taskAfter = dbModule.getTask("task-await-review-001");
    expect(taskAfter?.status).toBe("running_await_review");
  });

  it("其他 running 状态如果超时应被判作卡死", () => {
    // 注册工作流
    registryModule.register(makeTestWorkflowWithAwaitReview() as any);

    // 创建任务，状态为 running_step1，updated_at 为 30 分钟前
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    dbModule.createTask({
      id: "task-stuck-001",
      title: "卡死任务",
      workflow: "test_wf",
      initialStatus: "running_step1",
    });

    // 手动修改 updated_at 为 30 分钟前
    sqlite.run(
      "UPDATE tasks SET updated_at = ? WHERE id = ?",
      [thirtyMinutesAgo, "task-stuck-001"]
    );

    // 获取初始状态
    const taskBefore = dbModule.getTask("task-stuck-001");
    expect(taskBefore?.status).toBe("running_step1");

    // 调用 checkStuckTasks（timeout = 600 秒，即 10 分钟）
    watcherModule.checkStuckTasks(600);

    // 验证任务状态已改变（被强制转换回 pending）
    const taskAfter = dbModule.getTask("task-stuck-001");
    expect(taskAfter?.status).toBe("pending_step1");
  });
});
