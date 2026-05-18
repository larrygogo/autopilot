/**
 * recoverDanglingTasks(isRespawnContinuation) 测试 —— QA 第一轮盲区。
 *
 * 验证主动重启 vs 崩溃两条路径的行为分歧：
 * - isRespawnContinuation=true：所有 running_<phase> 走 runFn 自动 respawn 不标 dangling
 * - isRespawnContinuation=false：除 await_review 外其余 running_<phase> 标 dangling
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { _setDbForTest, createTask, getTask, updateTask, initDb } from "../src/core/db";
import { runPendingMigrations } from "../src/core/migrate";
import { recoverDanglingTasks } from "../src/daemon/index";

describe("recoverDanglingTasks", () => {
  let db: Database;
  let respawnCalls: Array<{ taskId: string; phase: string }>;
  const fakeRun = (taskId: string, phase: string) => {
    respawnCalls.push({ taskId, phase });
  };

  beforeAll(async () => {
    db = new Database(":memory:");
    _setDbForTest(db);
    initDb();
    await runPendingMigrations();
  });

  afterAll(() => {
    _setDbForTest(null);
    db.close();
  });

  beforeEach(() => {
    db.run("DELETE FROM tasks");
    respawnCalls = [];
  });

  function seedTask(id: string, status: string, opts: { dangling?: boolean } = {}): void {
    createTask({ id, title: id, workflow: "test_wf", initialStatus: "pending_seed" });
    const patch: Record<string, unknown> = { status };
    if (opts.dangling !== undefined) patch.dangling = opts.dangling;
    updateTask(id, patch);
  }

  describe("isRespawnContinuation=true (主动 daemon.restart)", () => {
    it("running_<phase> 自动 respawn 走 runFn 不标 dangling", () => {
      seedTask("t-run-1", "running_design");
      recoverDanglingTasks(true, { runInBackground: fakeRun });
      expect(respawnCalls).toEqual([{ taskId: "t-run-1", phase: "design" }]);
      const t = getTask("t-run-1");
      expect(t?.dangling).toBeFalsy();
    });

    it("running_await_review 也走 runFn（跟非主动重启行为一致）", () => {
      seedTask("t-rev-1", "running_await_review");
      recoverDanglingTasks(true, { runInBackground: fakeRun });
      expect(respawnCalls).toEqual([{ taskId: "t-rev-1", phase: "await_review" }]);
    });

    it("先前已标 dangling 的 running_<phase> 主动 restart 时清掉 dangling 标记", () => {
      seedTask("t-dang-1", "running_develop", { dangling: true });
      recoverDanglingTasks(true, { runInBackground: fakeRun });
      const t = getTask("t-dang-1");
      expect(t?.dangling).toBeFalsy();
      expect(respawnCalls.length).toBe(1);
    });

    it("done / pending_* / awaiting_* 不动", () => {
      seedTask("t-done", "done");
      seedTask("t-pend", "pending_design");
      seedTask("t-await", "awaiting_review");
      recoverDanglingTasks(true, { runInBackground: fakeRun });
      expect(respawnCalls).toEqual([]);
    });
  });

  describe("isRespawnContinuation=false (崩溃 / 干净启动)", () => {
    it("running_<phase>（非 await_review）标 dangling 不 respawn", () => {
      seedTask("t-crash-1", "running_design");
      recoverDanglingTasks(false, { runInBackground: fakeRun });
      expect(respawnCalls).toEqual([]);
      const t = getTask("t-crash-1");
      expect(t?.dangling).toBe(true);
    });

    it("running_await_review 仍自动 respawn（幂等 polling 阶段）", () => {
      seedTask("t-rev-2", "running_await_review");
      recoverDanglingTasks(false, { runInBackground: fakeRun });
      expect(respawnCalls).toEqual([{ taskId: "t-rev-2", phase: "await_review" }]);
    });

    it("已标 dangling 的 task 不重复处理（幂等）", () => {
      seedTask("t-dang-2", "running_develop", { dangling: true });
      recoverDanglingTasks(false, { runInBackground: fakeRun });
      expect(respawnCalls).toEqual([]);
      const t = getTask("t-dang-2");
      expect(t?.dangling).toBe(true); // 仍是 dangling
    });
  });
});
