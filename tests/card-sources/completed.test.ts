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
import { _setDbForTest, getDb, createTask } from "../../src/core/db";
import { createCompletedSource } from "../../src/core/card-sources/completed";

function initSchema(): void {
  const db = new Database(":memory:");
  [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011, m019].forEach(fn => fn(db));
  _setDbForTest(db);
}

function setDone(taskId: string, updatedAt: Date): void {
  getDb().run("UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?", [
    updatedAt.toISOString(), taskId,
  ]);
}

describe("CardSource: completed", () => {
  beforeEach(() => initSchema());

  it("scan 包含 24h 内完成的，排除超 24h 的", async () => {
    createTask({ id: "task-1", title: "T1", workflow: "dev", initialStatus: "draft" });
    createTask({ id: "task-2", title: "T2", workflow: "dev", initialStatus: "draft" });
    setDone("task-1", new Date(Date.now() - 1 * 3600_000));
    setDone("task-2", new Date(Date.now() - 48 * 3600_000));

    const cards = await createCompletedSource().scan();
    expect(cards.map(c => c.id)).toEqual(["completed:task-1"]);
    expect(cards[0].priority).toBe("P3");
    expect(cards[0].dismissable).toBe(true);
  });

  it("onEvent: 进入 done 产出 add", async () => {
    createTask({ id: "task-1", title: "T", workflow: "dev", initialStatus: "draft" });
    setDone("task-1", new Date());
    const deltas = await createCompletedSource().onEvent({
      type: "task:transition",
      payload: { taskId: "task-1", from: "running_submit_pr", to: "done", trigger: "pr_submitted" },
    });
    expect(deltas).toHaveLength(1);
    expect(deltas[0].op).toBe("add");
  });

  it("onEvent: 离开 done（极少见，比如手动改回 pending）产出 remove", async () => {
    const deltas = await createCompletedSource().onEvent({
      type: "task:transition",
      payload: { taskId: "task-1", from: "done", to: "running_design", trigger: "rerun" },
    });
    expect(deltas).toHaveLength(1);
    expect(deltas[0].op).toBe("remove");
  });
});
