import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { _setDbForTest, initDb, createTask, listTaskPhaseEvents } from "../src/core/db";
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
});
