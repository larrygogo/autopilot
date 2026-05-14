import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { _setDbForTest, initDb, startTaskPhase, endTaskPhase, createTask, updateTask } from "../src/core/db";
import { runPendingMigrations } from "../src/core/migrate";
import { computeTaskOutcome } from "../src/daemon/task-outcome";

let tmpHome: string;

beforeEach(async () => {
  tmpHome = join(tmpdir(), `autopilot-outcome-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "runtime"), { recursive: true });
  process.env.AUTOPILOT_HOME = tmpHome;
  _setDbForTest(new Database(":memory:"));
  initDb();
  await runPendingMigrations();
});

afterEach(() => {
  _setDbForTest(null);
  delete process.env.AUTOPILOT_HOME;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe("computeTaskOutcome", () => {
  it("非终态返回 null", async () => {
    createTask({ id: "task-001", title: "x", workflow: "dev", initialStatus: "running_design" });
    const o = await computeTaskOutcome("task-001");
    expect(o).toBeNull();
  });

  it("终态返回 outcome，包含 total_duration_ms + top_phases", async () => {
    createTask({ id: "task-002", title: "x", workflow: "dev", initialStatus: "running_design" });
    const a = startTaskPhase("task-002", "design");
    await new Promise((r) => setTimeout(r, 10));
    endTaskPhase(a, "done");
    const b = startTaskPhase("task-002", "review");
    await new Promise((r) => setTimeout(r, 20));
    endTaskPhase(b, "done");
    updateTask("task-002", { status: "done" });

    const o = await computeTaskOutcome("task-002");
    expect(o).not.toBeNull();
    expect(o!.status).toBe("done");
    expect(o!.total_duration_ms).toBeGreaterThan(0);
    expect(o!.top_phases.length).toBeGreaterThan(0);
    expect(o!.top_phases[0]!.duration_ms).toBeGreaterThanOrEqual(o!.top_phases[o!.top_phases.length - 1]!.duration_ms);
  });

  it("workspace 不存在 → diff_stat = null", async () => {
    createTask({ id: "task-003", title: "x", workflow: "dev", initialStatus: "done" });
    const o = await computeTaskOutcome("task-003");
    expect(o!.diff_stat).toBeNull();
  });
});
