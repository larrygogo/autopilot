import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { _setDbForTest, initDb, startTaskPhase, endTaskPhase, createTask, updateTask } from "../src/core/db";
import { runPendingMigrations } from "../src/core/migrate";
import { invokeRpcMethod } from "../src/daemon/rpc";
import { registerCoreRpcMethods } from "../src/daemon/rpc-methods";

let tmpHome: string;

beforeEach(async () => {
  tmpHome = join(tmpdir(), `autopilot-routes-pe-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "runtime"), { recursive: true });
  process.env.AUTOPILOT_HOME = tmpHome;
  _setDbForTest(new Database(":memory:"));
  initDb();
  await runPendingMigrations();
  registerCoreRpcMethods();
  createTask({ id: "task-001", title: "x", workflow: "dev", initialStatus: "running_design" });
});

afterEach(() => {
  _setDbForTest(null);
  delete process.env.AUTOPILOT_HOME;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe("tasks.phaseEvents RPC", () => {
  it("返回空数组（无 event）", async () => {
    const r = await invokeRpcMethod("tasks.phaseEvents", { id: "task-001" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const body = r.payload as { events: unknown[] };
      expect(body.events).toEqual([]);
    }
  });

  it("返回该 task 的全部 event", async () => {
    const id = startTaskPhase("task-001", "design");
    endTaskPhase(id, "done");
    startTaskPhase("task-001", "review");

    const r = await invokeRpcMethod("tasks.phaseEvents", { id: "task-001" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const body = r.payload as { events: Array<{ phase: string; status: string }> };
      expect(body.events.length).toBe(2);
      expect(body.events[0].phase).toBe("design");
      expect(body.events[0].status).toBe("done");
      expect(body.events[1].phase).toBe("review");
      expect(body.events[1].status).toBe("running");
    }
  });

  it("task 不存在 → 仍返回空数组（不强校验 task 存在）", async () => {
    const r = await invokeRpcMethod("tasks.phaseEvents", { id: "task-nonexistent" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const body = r.payload as { events: unknown[] };
      expect(body.events).toEqual([]);
    }
  });
});

describe("tasks.outcome RPC", () => {
  it("非终态 → NOT_FOUND", async () => {
    const r = await invokeRpcMethod("tasks.outcome", { id: "task-001" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("NOT_FOUND");
  });

  it("终态 → ok + outcome 结构完整", async () => {
    const a = startTaskPhase("task-001", "design");
    endTaskPhase(a, "done");
    updateTask("task-001", { status: "done" });

    const r = await invokeRpcMethod("tasks.outcome", { id: "task-001" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const body = r.payload as {
        status: string;
        total_duration_ms: number;
        top_phases: unknown[];
        diff_stat: unknown | null;
        pr_url: string | null;
      };
      expect(body.status).toBe("done");
      expect(typeof body.total_duration_ms).toBe("number");
      expect(Array.isArray(body.top_phases)).toBe(true);
      expect(body.diff_stat).toBeNull();
      expect(body.pr_url).toBeNull();
    }
  });
});
