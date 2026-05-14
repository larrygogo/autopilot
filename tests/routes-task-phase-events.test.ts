import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { handleRequest } from "../src/daemon/routes";
import { _setDbForTest, initDb, startTaskPhase, endTaskPhase, createTask } from "../src/core/db";
import { runPendingMigrations } from "../src/core/migrate";

let tmpHome: string;

beforeEach(async () => {
  tmpHome = join(tmpdir(), `autopilot-routes-pe-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "runtime"), { recursive: true });
  process.env.AUTOPILOT_HOME = tmpHome;
  _setDbForTest(new Database(":memory:"));
  initDb();
  await runPendingMigrations();
  createTask({ id: "task-001", title: "x", workflow: "dev", initialStatus: "running_design" });
});

afterEach(() => {
  _setDbForTest(null);
  delete process.env.AUTOPILOT_HOME;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe("GET /api/tasks/:id/phase-events", () => {
  it("返回空数组（无 event）", async () => {
    const res = await handleRequest(new Request("http://127.0.0.1:6180/api/tasks/task-001/phase-events"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toEqual([]);
  });

  it("返回该 task 的全部 event", async () => {
    const id = startTaskPhase("task-001", "design");
    endTaskPhase(id, "done");
    startTaskPhase("task-001", "review");

    const res = await handleRequest(new Request("http://127.0.0.1:6180/api/tasks/task-001/phase-events"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events.length).toBe(2);
    expect(body.events[0].phase).toBe("design");
    expect(body.events[0].status).toBe("done");
    expect(body.events[1].phase).toBe("review");
    expect(body.events[1].status).toBe("running");
  });

  it("task 不存在 → 仍 200 返回空（不强校验 task 存在）", async () => {
    const res = await handleRequest(new Request("http://127.0.0.1:6180/api/tasks/task-nonexistent/phase-events"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toEqual([]);
  });
});
