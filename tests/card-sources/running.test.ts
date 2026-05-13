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
import { createRunningSource } from "../../src/core/card-sources/running";

function initSchema(): void {
  const db = new Database(":memory:");
  [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011].forEach(fn => fn(db));
  _setDbForTest(db);
}

function setStatus(taskId: string, status: string): void {
  getDb().run("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?", [
    status, new Date().toISOString(), taskId,
  ]);
}

describe("CardSource: running", () => {
  beforeEach(() => initSchema());

  it("scan 返回所有 running_<phase> 但不含 running_await_review", async () => {
    createTask({ id: "task-1", title: "T1", workflow: "dev", initialStatus: "running_design" });
    createTask({ id: "task-2", title: "T2", workflow: "dev", initialStatus: "running_await_review" });
    createTask({ id: "task-3", title: "T3", workflow: "dev", initialStatus: "draft" });
    setStatus("task-3", "done");

    const cards = await createRunningSource().scan();
    expect(cards.map(c => c.id)).toEqual(["running:task-1"]);
    expect(cards[0].priority).toBe("P2");
    expect(cards[0].category).toBe("running");
    expect(cards[0].subtitle).toContain("design");
  });

  it("onEvent: 进入任意 running_X（非 await_review）产出 add", async () => {
    createTask({ id: "task-1", title: "T", workflow: "dev", initialStatus: "running_development" });
    const deltas = await createRunningSource().onEvent({
      type: "task:transition",
      payload: { taskId: "task-1", from: "running_design", to: "running_development", trigger: "x" },
    });
    expect(deltas).toHaveLength(1);
    expect(deltas[0].op).toBe("add");
  });

  it("onEvent: 进入 running_await_review 产出 remove（让 await-review source 接管）", async () => {
    const deltas = await createRunningSource().onEvent({
      type: "task:transition",
      payload: { taskId: "task-1", from: "running_design", to: "running_await_review", trigger: "x" },
    });
    expect(deltas).toHaveLength(1);
    expect(deltas[0].op).toBe("remove");
    if (deltas[0].op === "remove") expect(deltas[0].id).toBe("running:task-1");
  });

  it("onEvent: 从 running_X 转到非 running（done/failed/canceled）产出 remove", async () => {
    const deltas = await createRunningSource().onEvent({
      type: "task:transition",
      payload: { taskId: "task-1", from: "running_development", to: "done", trigger: "x" },
    });
    expect(deltas).toHaveLength(1);
    expect(deltas[0].op).toBe("remove");
  });

  it("onEvent: 同 running_X 之间切换（如 design → development）产出 add（upsert 语义）", async () => {
    createTask({ id: "task-1", title: "T", workflow: "dev", initialStatus: "running_development" });
    const deltas = await createRunningSource().onEvent({
      type: "task:transition",
      payload: { taskId: "task-1", from: "running_design", to: "running_development", trigger: "x" },
    });
    expect(deltas).toHaveLength(1);
    expect(["add", "update"]).toContain(deltas[0].op);
  });
});
