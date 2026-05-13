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
import { _setDbForTest } from "../../src/core/db";
import { createStuckSource } from "../../src/core/card-sources/stuck";

function initSchema(): void {
  const db = new Database(":memory:");
  [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011].forEach(fn => fn(db));
  _setDbForTest(db);
}

describe("CardSource: stuck", () => {
  beforeEach(() => initSchema());

  it("name = 'stuck'，订阅 watcher:recovery", () => {
    const src = createStuckSource();
    expect(src.name).toBe("stuck");
    expect(src.subscribes).toEqual(["watcher:recovery"]);
  });

  it("scan 返回空（stuck 卡只在事件来时产生，无持久来源）", async () => {
    expect(await createStuckSource().scan()).toEqual([]);
  });

  it("onEvent: watcher:recovery 产出 P1 add 卡，dismissable=true", async () => {
    const deltas = await createStuckSource().onEvent({
      type: "watcher:recovery",
      payload: { taskId: "task-1", phase: "development", fromStatus: "running_development", toStatus: "pending_development" },
    });
    expect(deltas).toHaveLength(1);
    if (deltas[0].op === "add") {
      expect(deltas[0].card.id).toBe("stuck:task-1");
      expect(deltas[0].card.priority).toBe("P1");
      expect(deltas[0].card.dismissable).toBe(true);
      expect(deltas[0].card.related).toEqual({ type: "task", id: "task-1" });
    }
  });
});
