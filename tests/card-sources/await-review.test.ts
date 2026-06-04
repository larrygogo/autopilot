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
import { up as m019 } from "../../src/migrations/019-task-requirement-id";
import { up as m021 } from "../../src/migrations/021-requirement-comments";
import { up as m024 } from "../../src/migrations/024-codebase-to-workspace";
import { _setDbForTest, getDb, createTask } from "../../src/core/db";
import { createAwaitReviewSource } from "../../src/core/card-sources/await-review";

function initSchema(): void {
  const db = new Database(":memory:");
  [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011, m019, m021, m024].forEach(fn => fn(db));
  _setDbForTest(db);
}

function setStatus(taskId: string, status: string): void {
  getDb().run("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?", [
    status, new Date().toISOString(), taskId,
  ]);
}

describe("CardSource: await-review", () => {
  beforeEach(() => initSchema());

  it("name = 'await-review'，订阅 task:transition", () => {
    const src = createAwaitReviewSource();
    expect(src.name).toBe("await-review");
    expect(src.subscribes).toContain("task:transition");
  });

  it("scan 返回所有 status=running_await_review 的 task 为 P1 决策卡", async () => {
    createTask({ id: "task-1", title: "T1", workflow: "dev", initialStatus: "running_design" });
    setStatus("task-1", "running_await_review");
    createTask({ id: "task-2", title: "T2", workflow: "dev", initialStatus: "running_design" });
    setStatus("task-2", "running_design");

    const cards = await createAwaitReviewSource().scan();
    expect(cards.map(c => c.id)).toEqual(["await-review:task-1"]);
    expect(cards[0].priority).toBe("P1");
    expect(cards[0].related).toEqual({ type: "task", id: "task-1" });
    expect(cards[0].actions.some(a => a.label === "看方案" && a.kind === "primary")).toBe(true);
    expect(cards[0].actions.some(a => a.label === "驳回" && a.kind === "danger")).toBe(true);
  });

  it("onEvent: to running_await_review 产出 add", async () => {
    createTask({ id: "task-1", title: "T", workflow: "dev", initialStatus: "running_design" });
    setStatus("task-1", "running_await_review");
    const deltas = await createAwaitReviewSource().onEvent({
      type: "task:transition",
      payload: { taskId: "task-1", from: "running_design", to: "running_await_review", trigger: "design_done" },
    });
    expect(deltas).toHaveLength(1);
    expect(deltas[0].op).toBe("add");
  });

  it("onEvent: from running_await_review 产出 remove", async () => {
    const deltas = await createAwaitReviewSource().onEvent({
      type: "task:transition",
      payload: { taskId: "task-1", from: "running_await_review", to: "running_development", trigger: "approved" },
    });
    expect(deltas).toHaveLength(1);
    expect(deltas[0].op).toBe("remove");
    if (deltas[0].op === "remove") expect(deltas[0].id).toBe("await-review:task-1");
  });

  it("onEvent: 既不是去也不是离 await_review 返回空", async () => {
    const deltas = await createAwaitReviewSource().onEvent({
      type: "task:transition",
      payload: { taskId: "task-1", from: "running_design", to: "running_development", trigger: "x" },
    });
    expect(deltas).toEqual([]);
  });
});
