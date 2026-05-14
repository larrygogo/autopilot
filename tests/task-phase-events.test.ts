import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { _setDbForTest, initDb, createTask, startTaskPhase, endTaskPhase, listTaskPhaseEvents } from "../src/core/db";
import { runPendingMigrations } from "../src/core/migrate";

let tmpHome: string;

function seedTask(id: string) {
  createTask({ id, title: id, workflow: "test", initialStatus: "pending" });
}

beforeEach(async () => {
  tmpHome = join(tmpdir(), `autopilot-phase-events-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "runtime"), { recursive: true });
  process.env.AUTOPILOT_HOME = tmpHome;
  _setDbForTest(new Database(":memory:"));
  initDb();
  await runPendingMigrations();
  seedTask("task-001");
  seedTask("task-002");
});

afterEach(() => {
  _setDbForTest(null);
  delete process.env.AUTOPILOT_HOME;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe("task_phase_events", () => {
  it("startTaskPhase 写入 + 返回 id", () => {
    const id = startTaskPhase("task-001", "design");
    expect(typeof id).toBe("number");
    expect(id).toBeGreaterThan(0);
  });

  it("endTaskPhase 更新 ended_at + status", () => {
    const id = startTaskPhase("task-001", "design");
    endTaskPhase(id, "done");
    const events = listTaskPhaseEvents("task-001");
    expect(events.length).toBe(1);
    expect(events[0]!.status).toBe("done");
    expect(events[0]!.ended_at).not.toBeNull();
  });

  it("同 phase 多次重试 → 多行", () => {
    const id1 = startTaskPhase("task-001", "design");
    endTaskPhase(id1, "failed");
    const id2 = startTaskPhase("task-001", "design");
    endTaskPhase(id2, "done");
    const events = listTaskPhaseEvents("task-001");
    expect(events.length).toBe(2);
    expect(events[0]!.status).toBe("failed");
    expect(events[1]!.status).toBe("done");
  });

  it("listTaskPhaseEvents 按 started_at 升序", () => {
    const a = startTaskPhase("task-001", "design");
    const start = Date.now();
    while (Date.now() === start) { /* spin until next ms */ }
    const b = startTaskPhase("task-001", "review");
    const events = listTaskPhaseEvents("task-001");
    expect(events[0]!.id).toBe(a);
    expect(events[1]!.id).toBe(b);
  });

  it("不同 task 隔离", () => {
    startTaskPhase("task-001", "design");
    startTaskPhase("task-002", "design");
    expect(listTaskPhaseEvents("task-001").length).toBe(1);
    expect(listTaskPhaseEvents("task-002").length).toBe(1);
  });
});
