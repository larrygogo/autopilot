import { describe, it, expect, beforeEach, afterEach, setSystemTime } from "bun:test";
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
  "    requirement_id TEXT DEFAULT NULL,",
  "    kind TEXT NOT NULL DEFAULT 'execution',",
  "    seq INTEGER NOT NULL DEFAULT 1",
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
  "    ended_at INTEGER",
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

function makeTestWorkflowWithParallel() {
  return {
    name: "test_par_wf",
    description: "测试并行块",
    phases: [
      {
        parallel: {
          name: "build",
          fail_strategy: "cancel_all",
          phases: [
            { name: "frontend", pending_state: "pending_frontend", running_state: "running_frontend", trigger: "start_frontend", complete_trigger: "frontend_complete", fail_trigger: "frontend_fail", label: "FE", func: async (_t: string) => {} },
            { name: "backend", pending_state: "pending_backend", running_state: "running_backend", trigger: "start_backend", complete_trigger: "backend_complete", fail_trigger: "backend_fail", label: "BE", func: async (_t: string) => {} },
          ],
        },
      },
    ],
    initial_state: "pending_build",
    terminal_states: ["done", "cancelled"],
  };
}

// ──────────────────────────────────────────────
// 测试套件
// ──────────────────────────────────────────────

describe("watcher - checkStuckTasks", () => {
  let sqlite: Database;
  let dbModule: typeof import("../src/core/db");
  let registryModule: typeof import("../src/core/workflow/registry");
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
    registryModule = await import("../src/core/workflow/registry");
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

  it("running_await_review 超时（heartbeat 丢失）也应被恢复", () => {
    // 注册工作流
    registryModule.register(makeTestWorkflowWithAwaitReview() as any);

    // 创建任务，状态为 running_await_review，updated_at 为 30 分钟前
    // 旧设计：豁免 await_review 永不恢复 —— 但 sygvsxmy 这种 deterministic 崩溃
    //         会导致 heartbeat 停止后永久卡死（见 fix/await-review-stuck-recovery-20260512）
    // 新设计：runner 心跳每 2 分钟更新 updated_at；正常 polling 不会被误杀，
    //         只有阶段函数死了 + heartbeat 丢失 + 锁释放 → watcher 接管恢复
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    dbModule.createTask({
      id: "task-await-review-001",
      title: "长挂起任务",
      workflow: "test_wf",
      initialStatus: "running_await_review",
    });

    sqlite.run(
      "UPDATE tasks SET updated_at = ? WHERE id = ?",
      [thirtyMinutesAgo, "task-await-review-001"]
    );

    const taskBefore = dbModule.getTask("task-await-review-001");
    expect(taskBefore?.status).toBe("running_await_review");

    // 调用 checkStuckTasks（timeout = 600 秒）；30 分钟无 heartbeat → 应被恢复
    watcherModule.checkStuckTasks(600);

    // 验证任务被弹回 pending_await_review（等待重新 spawn）
    const taskAfter = dbModule.getTask("task-await-review-001");
    expect(taskAfter?.status).toBe("pending_await_review");
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

  it("waiting_<group> 并行块挂起超时 → 回退 pending_<group> 重跑整组（CONC-01）", () => {
    // 并行块 fork 后挂在 waiting_build；daemon 崩溃/重启后子阶段内存 promise 丢失。
    // 修前 watcher 只认 running_ → waiting_build 永久卡死，无人恢复。
    registryModule.register(makeTestWorkflowWithParallel() as any);

    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    dbModule.createTask({
      id: "task-par-001",
      title: "并行块挂起卡死",
      workflow: "test_par_wf",
      initialStatus: "waiting_build",
    });
    sqlite.run("UPDATE tasks SET updated_at = ? WHERE id = ?", [thirtyMinAgo, "task-par-001"]);

    expect(dbModule.getTask("task-par-001")?.status).toBe("waiting_build");
    watcherModule.checkStuckTasks(600);
    // 回退到 pending_build，让 runner 重新 fork 跑整组
    expect(dbModule.getTask("task-par-001")?.status).toBe("pending_build");
  });

  it("waiting_<未知group>（工作流无此并行块）→ 不误恢复，跳过", () => {
    registryModule.register(makeTestWorkflowWithParallel() as any);
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    dbModule.createTask({
      id: "task-par-002",
      title: "未知并行块",
      workflow: "test_par_wf",
      initialStatus: "waiting_nonexistent",
    });
    sqlite.run("UPDATE tasks SET updated_at = ? WHERE id = ?", [thirtyMinAgo, "task-par-002"]);

    watcherModule.checkStuckTasks(600);
    // group 不存在于工作流 → isParallelGroup 假 → 不动状态
    expect(dbModule.getTask("task-par-002")?.status).toBe("waiting_nonexistent");
  });

  it("phase 成功清恢复计数 → 同一 phase 反复返工卡死不累积到误判 failed（RERUN-02）", () => {
    registryModule.register(makeTestWorkflowWithAwaitReview() as any);
    dbModule.createTask({
      id: "task-rerun-02",
      title: "反复返工任务",
      workflow: "test_wf",
      initialStatus: "running_step1",
    });

    // 模拟 code_review reject→retry_develop 反复重入同一 step1：每轮卡死→watcher 恢复→
    // （模拟该轮 phase 成功）清恢复计数。MAX_RECOVERIES_PER_PHASE=3，但每轮成功清零 →
    // 累计永不到 3 → 永远恢复到 pending，绝不被误判 failed。
    // 注：clearPhaseRecoveryCount 同时清 lastRecoveryAttempt，故下一轮 checkStuckTasks 不被
    // 60s 节流挡住 —— 这正是 runner 成功后调它的副作用之一。
    for (let round = 0; round < 5; round++) {
      sqlite.run(
        "UPDATE tasks SET status='running_step1', updated_at=? WHERE id=?",
        [new Date(Date.now() - 30 * 60 * 1000).toISOString(), "task-rerun-02"],
      );
      watcherModule.checkStuckTasks(600);
      expect(dbModule.getTask("task-rerun-02")?.status).toBe("pending_step1");
      // runner 在 phase 成功完成时调此函数
      watcherModule.clearPhaseRecoveryCount("task-rerun-02", "step1");
    }
  });

  it("卡死恢复重跑前关闭遗留 open phase event（标 aborted）—— 否则执行时间线出现多轮并行转圈僵尸", () => {
    // dogfood 实锤（yrw66qe6）：daemon 重启打断 running phase → watcher 恢复重跑，
    // 但旧轮 phase event 永远 ended_at=NULL/status=running → UI 多个轮次同时转圈、
    // 耗时累计到 now、日志窗口无限（与新轮日志切片完全重叠）。
    registryModule.register(makeTestWorkflowWithAwaitReview() as any);
    dbModule.createTask({
      id: "task-zombie-event",
      title: "被打断的任务",
      workflow: "test_wf",
      initialStatus: "running_step1",
    });
    const orphanEventId = dbModule.startTaskPhase("task-zombie-event", "step1");
    sqlite.run(
      "UPDATE tasks SET updated_at = ? WHERE id = ?",
      [new Date(Date.now() - 30 * 60 * 1000).toISOString(), "task-zombie-event"],
    );

    watcherModule.checkStuckTasks(600);
    expect(dbModule.getTask("task-zombie-event")?.status).toBe("pending_step1");

    const orphan = dbModule
      .listTaskPhaseEvents("task-zombie-event")
      .find((e) => e.id === orphanEventId);
    expect(orphan?.status).toBe("aborted");
    expect(orphan?.ended_at).not.toBeNull();
  });

  it("恢复触顶转 failed 时同样关闭 open phase event（失败任务不留转圈僵尸轮）", () => {
    registryModule.register(makeTestWorkflowWithAwaitReview() as any);
    dbModule.createTask({
      id: "task-zombie-cap",
      title: "反复卡死触顶的任务",
      workflow: "test_wf",
      initialStatus: "running_step1",
    });

    // 推进 4 轮：前 3 轮正常恢复（MAX_RECOVERIES_PER_PHASE=3），第 4 轮触顶转 failed。
    // setSystemTime 推进时钟绕过 60s 恢复节流。
    const base = Date.now();
    for (let round = 0; round < 4; round++) {
      setSystemTime(new Date(base + round * 120_000));
      sqlite.run(
        "UPDATE tasks SET status='running_step1', updated_at=? WHERE id=?",
        [new Date(Date.now() - 30 * 60 * 1000).toISOString(), "task-zombie-cap"],
      );
      dbModule.startTaskPhase("task-zombie-cap", "step1");
      watcherModule.checkStuckTasks(600);
    }
    setSystemTime();

    expect(dbModule.getTask("task-zombie-cap")?.status).toBe("failed");
    const open = dbModule
      .listTaskPhaseEvents("task-zombie-cap")
      .filter((e) => e.ended_at === null);
    expect(open).toHaveLength(0);
  });

  it("running_await_review 在 heartbeat 内（updated_at 新）不应被误恢复", () => {
    // 注册工作流
    registryModule.register(makeTestWorkflowWithAwaitReview() as any);

    // 创建任务，updated_at 为 1 分钟前 — 模拟 heartbeat 持续中
    const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();
    dbModule.createTask({
      id: "task-await-alive-001",
      title: "正常 polling 中的任务",
      workflow: "test_wf",
      initialStatus: "running_await_review",
    });

    sqlite.run(
      "UPDATE tasks SET updated_at = ? WHERE id = ?",
      [oneMinuteAgo, "task-await-alive-001"]
    );

    // checkStuckTasks 默认阈值 600 秒；1 分钟前心跳 → 不应被恢复
    watcherModule.checkStuckTasks(600);

    const taskAfter = dbModule.getTask("task-await-alive-001");
    expect(taskAfter?.status).toBe("running_await_review");
  });
});
