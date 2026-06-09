import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { _setDbForTest, initDb, createTask, updateTask, getTask, listTaskPhaseEvents } from "../src/core/db";
import { runPendingMigrations } from "../src/core/migrate";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ──────────────────────────────────────────────
// 工作流辅助
// ──────────────────────────────────────────────

function makeNormalWorkflow(phaseFn: (taskId: string) => Promise<void>) {
  return {
    name: "pe_normal_wf",
    description: "phase event 测试：正常完成",
    phases: [
      {
        name: "design",
        pending_state: "pending_design",
        running_state: "running_design",
        trigger: "start_design",
        complete_trigger: "design_complete",
        fail_trigger: "design_fail",
        label: "DESIGN",
        func: phaseFn,
      },
    ],
    initial_state: "pending_design",
    terminal_states: ["done", "cancelled"],
  };
}

function makeFailWorkflow(phaseFn: (taskId: string) => Promise<void>) {
  return {
    name: "pe_fail_wf",
    description: "phase event 测试：抛错",
    phases: [
      {
        name: "design",
        pending_state: "pending_design",
        running_state: "running_design",
        trigger: "start_design",
        complete_trigger: "design_complete",
        fail_trigger: "design_fail",
        label: "DESIGN",
        func: phaseFn,
      },
    ],
    initial_state: "pending_design",
    terminal_states: ["done", "cancelled"],
  };
}

function makeGateWorkflow(phaseFn: (taskId: string) => Promise<void>) {
  return {
    name: "pe_gate_wf",
    description: "phase event 测试：gate",
    phases: [
      {
        name: "design",
        pending_state: "pending_design",
        running_state: "running_design",
        trigger: "start_design",
        complete_trigger: "design_complete",
        fail_trigger: "design_fail",
        label: "DESIGN",
        gate: true,
        func: phaseFn,
      },
    ],
    initial_state: "pending_design",
    terminal_states: ["done", "cancelled"],
  };
}

// ──────────────────────────────────────────────
// 测试套件
// ──────────────────────────────────────────────

describe("runner phase events 集成", () => {
  let sqlite: Database;
  let dbModule: typeof import("../src/core/db");
  let registryModule: typeof import("../src/core/registry");
  let runnerModule: typeof import("../src/core/runner");
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = join(
      tmpdir(),
      `autopilot-runner-pe-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(join(tmpHome, "runtime"), { recursive: true });
    process.env.AUTOPILOT_HOME = tmpHome;

    sqlite = new Database(":memory:");
    sqlite.run("PRAGMA journal_mode=WAL");
    sqlite.run("PRAGMA foreign_keys=ON");

    dbModule = await import("../src/core/db");
    dbModule._setDbForTest(sqlite);
    dbModule.initDb();
    await runPendingMigrations();

    registryModule = await import("../src/core/registry");
    runnerModule = await import("../src/core/runner");

    registryModule._clearRegistry();
  });

  afterEach(() => {
    registryModule._clearRegistry();
    dbModule._setDbForTest(null);
    sqlite.close();
    delete process.env.AUTOPILOT_HOME;
    if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
  });

  it("phase 函数成功完成 → started + ended(done) 一对", async () => {
    const phaseFn = async (_taskId: string) => { /* no-op */ };
    registryModule.register(makeNormalWorkflow(phaseFn) as any);

    createTask({
      id: "task-pe-001",
      title: "test",
      workflow: "pe_normal_wf",
      initialStatus: "pending_design",
    });

    await runnerModule.executePhase("task-pe-001", "design");

    const events = listTaskPhaseEvents("task-pe-001");
    expect(events.length).toBe(1);
    expect(events[0]!.phase).toBe("design");
    expect(events[0]!.status).toBe("done");
    expect(events[0]!.ended_at).not.toBeNull();
  });

  it("phase 函数抛错 → ended(failed)", async () => {
    const phaseFn = async (_taskId: string) => {
      throw new Error("boom");
    };
    registryModule.register(makeFailWorkflow(phaseFn) as any);

    createTask({
      id: "task-pe-002",
      title: "test",
      workflow: "pe_fail_wf",
      initialStatus: "pending_design",
    });

    await runnerModule.executePhase("task-pe-002", "design");

    const events = listTaskPhaseEvents("task-pe-002");
    expect(events.length).toBe(1);
    expect(events[0]!.phase).toBe("design");
    expect(events[0]!.status).toBe("failed");
    expect(events[0]!.ended_at).not.toBeNull();
  });

  it("gate phase 完成 → ended(awaiting)", async () => {
    const phaseFn = async (_taskId: string) => { /* no-op */ };
    registryModule.register(makeGateWorkflow(phaseFn) as any);

    createTask({
      id: "task-pe-003",
      title: "test",
      workflow: "pe_gate_wf",
      initialStatus: "pending_design",
    });

    await runnerModule.executePhase("task-pe-003", "design");

    const events = listTaskPhaseEvents("task-pe-003");
    expect(events.length).toBe(1);
    expect(events[0]!.phase).toBe("design");
    expect(events[0]!.status).toBe("awaiting");
    expect(events[0]!.ended_at).not.toBeNull();
  });

  it("phase 函数自己 transition（自转移工作流）→ finally 兜底 close，无僵尸 running event（ERL-1/ERL-2）", async () => {
    const { forceTransition } = await import("../src/core/state-machine");
    // 模拟 dev 工作流：phase 函数自己把状态转走（自转移），使 executePhase 的守卫块
    // current.status === running_state（runner.ts:220）为假而整体跳过 close。
    const phaseFn = async (taskId: string) => {
      forceTransition(taskId, "done", "test: phase 自转移");
    };
    registryModule.register(makeNormalWorkflow(phaseFn) as any);

    createTask({
      id: "task-pe-selftrans",
      title: "test",
      workflow: "pe_normal_wf",
      initialStatus: "pending_design",
    });

    await runnerModule.executePhase("task-pe-selftrans", "design");

    // ERL-1 回归：自转移后该 phase event 仍被 executePhase 的 finally 兜底 close（修前会留
    // status='running'/ended_at=null 的僵尸 → Web 阶段进度恒"进行中"+耗时虚高 + P50 失真）。
    const events = listTaskPhaseEvents("task-pe-selftrans");
    expect(events.length).toBe(1);
    expect(events[0]!.phase).toBe("design");
    expect(events[0]!.status).toBe("done");
    expect(events[0]!.ended_at).not.toBeNull();
  });

  it("phase 成功完成 → 清 dangling 标志（被 watcher 救活的任务跑到 done 不残留失联）", async () => {
    const phaseFn = async (_taskId: string) => { /* no-op */ };
    registryModule.register(makeNormalWorkflow(phaseFn) as any);

    createTask({ id: "task-pe-dangling", title: "test", workflow: "pe_normal_wf", initialStatus: "pending_design" });
    // 模拟该任务曾被 watcher 标记失联（daemon 重启丢内存执行流）
    updateTask("task-pe-dangling", { dangling: true });
    expect(getTask("task-pe-dangling")?.dangling).toBeTruthy();

    await runnerModule.executePhase("task-pe-dangling", "design");

    // phase 成功 = 任务活着且在推进 → dangling 归零，避免跑到 done 仍挂"任务已失联"红横幅
    expect(getTask("task-pe-dangling")?.dangling).toBeFalsy();
  });
});
