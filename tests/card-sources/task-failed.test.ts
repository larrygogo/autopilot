import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { up as m001 } from "../../src/migrations/001-baseline";
import { up as m002 } from "../../src/migrations/002-schedules";
import { up as m004 } from "../../src/migrations/004-repos";
import { up as m005 } from "../../src/migrations/005-requirements";
import { up as m006 } from "../../src/migrations/006-submodules";
import { up as m007 } from "../../src/migrations/007-workflows";
import { up as m008 } from "../../src/migrations/008-projects";
import { up as m009 } from "../../src/migrations/009-nullable-codebase";
import { up as m010 } from "../../src/migrations/010-question-suggestions";
import { up as m011 } from "../../src/migrations/011-now-dismissed-cards";
import { _setDbForTest, getDb, createTask } from "../../src/core/db";
import { createTaskFailedSource } from "../../src/core/card-sources/task-failed";

function initSchema(): void {
  const db = new Database(":memory:");
  [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011].forEach(fn => fn(db));
  _setDbForTest(db);
}

function setFailed(taskId: string): void {
  getDb().run("UPDATE tasks SET status = 'failed', updated_at = ? WHERE id = ?", [
    new Date().toISOString(), taskId,
  ]);
}

describe("CardSource: task-failed", () => {
  beforeEach(() => initSchema());

  it("scan 拉所有 status=failed 的 task 作 P0 卡", async () => {
    createTask({ id: "task-1", title: "T1", workflow: "dev", initialStatus: "draft" });
    setFailed("task-1");
    createTask({ id: "task-2", title: "T2", workflow: "dev", initialStatus: "draft" });

    const cards = await createTaskFailedSource().scan();
    expect(cards.map(c => c.id)).toEqual(["task-failed:task-1"]);
    expect(cards[0].priority).toBe("P0");
    expect(cards[0].category).toBe("error");
    expect(cards[0].dismissable).toBe(true);
  });

  it("onEvent: 进入 failed 产出 add", async () => {
    createTask({ id: "task-1", title: "T", workflow: "dev", initialStatus: "draft" });
    setFailed("task-1");
    const deltas = await createTaskFailedSource().onEvent({
      type: "task:transition",
      payload: { taskId: "task-1", from: "running_development", to: "failed", trigger: "error" },
    });
    expect(deltas).toHaveLength(1);
    expect(deltas[0].op).toBe("add");
  });

  it("onEvent: 离开 failed（重试）产出 remove", async () => {
    const deltas = await createTaskFailedSource().onEvent({
      type: "task:transition",
      payload: { taskId: "task-1", from: "failed", to: "pending_development", trigger: "retry" },
    });
    expect(deltas).toHaveLength(1);
    expect(deltas[0].op).toBe("remove");
  });
});
