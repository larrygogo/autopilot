import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";

// ──────────────────────────────────────────────
// 测试辅助
// ──────────────────────────────────────────────

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS tasks (",
  "    id TEXT PRIMARY KEY,",
  "    title TEXT NOT NULL,",
  "    workflow TEXT NOT NULL,",
  "    status TEXT NOT NULL,",
  "    failure_count INTEGER DEFAULT 0,",
  "    channel TEXT DEFAULT 'log',",
  "    notify_target TEXT,",
  "    extra TEXT DEFAULT '{}',",
  "    created_at TEXT NOT NULL,",
  "    updated_at TEXT NOT NULL,",
  "    started_at TEXT,",
  "    parent_task_id TEXT DEFAULT NULL,",
  "    parallel_index INTEGER DEFAULT NULL,",
  "    parallel_group TEXT DEFAULT NULL",
  ");",
  "",
  "CREATE TABLE IF NOT EXISTS task_logs (",
  "    id INTEGER PRIMARY KEY AUTOINCREMENT,",
  "    task_id TEXT NOT NULL,",
  "    from_status TEXT,",
  "    to_status TEXT NOT NULL,",
  "    trigger_name TEXT,",
  "    note TEXT,",
  "    created_at TEXT NOT NULL,",
  "    FOREIGN KEY (task_id) REFERENCES tasks(id)",
  ");",
].join("\n");

async function withTestDb<T>(
  fn: (
    db: typeof import("../src/core/db"),
    sm: typeof import("../src/core/state-machine")
  ) => T | Promise<T>
): Promise<T> {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA journal_mode=WAL");
  sqlite.run("PRAGMA foreign_keys=ON");
  sqlite.exec(SCHEMA);

  const dbModule = await import("../src/core/db");
  const smModule = await import("../src/core/state-machine");
  (dbModule as any)._setDbForTest(sqlite);

  try {
    return await fn(dbModule, smModule);
  } finally {
    (dbModule as any)._setDbForTest(null);
    sqlite.close();
  }
}

// 测试转换表：pending -> running_phase1 -> done / failed
const TRANSITIONS = {
  pending: [
    ["start", "running_phase1"],
    ["cancel", "cancelled"],
  ],
  running_phase1: [
    ["complete", "done"],
    ["fail", "failed"],
    ["reset", "pending"],
  ],
  done: [],
  failed: [["retry", "pending"]],
  cancelled: [],
} as Record<string, [string, string][]>;

// ──────────────────────────────────────────────
// 测试用例
// ──────────────────────────────────────────────

describe("state-machine 模块", () => {
  describe("transition - 合法转换", () => {
    it("合法转换应成功并返回 [fromStatus, toStatus]", async () => {
      await withTestDb(async (db, sm) => {
        db.initDb();
        db.createTask({
          id: "task-sm-001",
          title: "SM 测试",
          workflow: "test",
          initialStatus: "pending",
        });

        const [from, to] = sm.transition("task-sm-001", "start", {
          transitions: TRANSITIONS,
        });

        expect(from).toBe("pending");
        expect(to).toBe("running_phase1");

        const task = db.getTask("task-sm-001");
        expect(task!.status).toBe("running_phase1");
      });
    });

    it("转换到 running 开头的状态时应更新 started_at", async () => {
      await withTestDb(async (db, sm) => {
        db.initDb();
        db.createTask({
          id: "task-sm-002",
          title: "started_at 测试",
          workflow: "test",
          initialStatus: "pending",
        });

        expect(db.getTask("task-sm-002")!.started_at).toBeNull();

        sm.transition("task-sm-002", "start", { transitions: TRANSITIONS });

        const task = db.getTask("task-sm-002");
        expect(task!.status).toBe("running_phase1");
        expect(task!.started_at).not.toBeNull();
      });
    });

    it("转换到非 running 状态时不应修改 started_at（保持 null）", async () => {
      await withTestDb(async (db, sm) => {
        db.initDb();
        db.createTask({
          id: "task-sm-003",
          title: "cancel 测试",
          workflow: "test",
          initialStatus: "pending",
        });

        sm.transition("task-sm-003", "cancel", { transitions: TRANSITIONS });

        const task = db.getTask("task-sm-003");
        expect(task!.status).toBe("cancelled");
        expect(task!.started_at).toBeNull();
      });
    });
  });

  describe("transition - 非법转换", () => {
    it("非法转换应抛出 InvalidTransitionError", async () => {
      await withTestDb(async (db, sm) => {
        db.initDb();
        db.createTask({
          id: "task-sm-004",
          title: "非法转换测试",
          workflow: "test",
          initialStatus: "pending",
        });

        expect(() => {
          sm.transition("task-sm-004", "complete", { transitions: TRANSITIONS });
        }).toThrow(sm.InvalidTransitionError);
      });
    });

    it("非法转换不应改变任务状态", async () => {
      await withTestDb(async (db, sm) => {
        db.initDb();
        db.createTask({
          id: "task-sm-005",
          title: "状态保持测试",
          workflow: "test",
          initialStatus: "pending",
        });

        try {
          sm.transition("task-sm-005", "fail", { transitions: TRANSITIONS });
        } catch {
          // 预期抛出
        }

        expect(db.getTask("task-sm-005")!.status).toBe("pending");
      });
    });

    it("任务不存在时应抛出 InvalidTransitionError", async () => {
      await withTestDb(async (_, sm) => {
        expect(() => {
          sm.transition("nonexistent-task", "start", { transitions: TRANSITIONS });
        }).toThrow(sm.InvalidTransitionError);
      });
    });
  });

  describe("canTransition - 转换检查", () => {
    it("合法转换应返回 true", async () => {
      await withTestDb(async (db, sm) => {
        db.initDb();
        db.createTask({
          id: "task-sm-006",
          title: "canTransition true 测试",
          workflow: "test",
          initialStatus: "pending",
        });

        expect(
          sm.canTransition("task-sm-006", "start", { transitions: TRANSITIONS })
        ).toBe(true);
      });
    });

    it("非法转换应返回 false", async () => {
      await withTestDb(async (db, sm) => {
        db.initDb();
        db.createTask({
          id: "task-sm-007",
          title: "canTransition false 测试",
          workflow: "test",
          initialStatus: "pending",
        });

        expect(
          sm.canTransition("task-sm-007", "complete", { transitions: TRANSITIONS })
        ).toBe(false);
      });
    });

    it("任务不存在时应返回 false", async () => {
      await withTestDb(async (_, sm) => {
        expect(
          sm.canTransition("nonexistent", "start", { transitions: TRANSITIONS })
        ).toBe(false);
      });
    });
  });

  describe("getAvailableTriggers - 可用触发器", () => {
    it("应返回当前状态下所有可用 trigger", async () => {
      await withTestDb(async (db, sm) => {
        db.initDb();
        db.createTask({
          id: "task-sm-008",
          title: "triggers 测试",
          workflow: "test",
          initialStatus: "pending",
        });

        const triggers = sm.getAvailableTriggers("task-sm-008", {
          transitions: TRANSITIONS,
        });

        expect(triggers).toContain("start");
        expect(triggers).toContain("cancel");
        expect(triggers.length).toBe(2);
      });
    });

    it("终态应返回空列表", async () => {
      await withTestDb(async (db, sm) => {
        db.initDb();
        db.createTask({
          id: "task-sm-009",
          title: "终态 triggers 测试",
          workflow: "test",
          initialStatus: "done",
        });

        const triggers = sm.getAvailableTriggers("task-sm-009", {
          transitions: TRANSITIONS,
        });
        expect(triggers).toEqual([]);
      });
    });

    it("任务不存在时应返回空列表", async () => {
      await withTestDb(async (_, sm) => {
        const triggers = sm.getAvailableTriggers("nonexistent", {
          transitions: TRANSITIONS,
        });
        expect(triggers).toEqual([]);
      });
    });
  });

  describe("transition - task_logs 记录", () => {
    it("转换后应在 task_logs 中写入记录", async () => {
      await withTestDb(async (db, sm) => {
        db.initDb();
        db.createTask({
          id: "task-sm-010",
          title: "日志测试",
          workflow: "test",
          initialStatus: "pending",
        });

        sm.transition("task-sm-010", "start", {
          transitions: TRANSITIONS,
          note: "测试备注",
        });

        const logs = db.getTaskLogs("task-sm-010");
        expect(logs.length).toBe(1);

        const log = logs[0];
        expect(log.task_id).toBe("task-sm-010");
        expect(log.from_status).toBe("pending");
        expect(log.to_status).toBe("running_phase1");
        expect(log.trigger_name).toBe("start");
        expect(log.note).toBe("测试备注");
        expect(log.created_at).toBeTruthy();
      });
    });

    it("多次转换应产生多条日志", async () => {
      await withTestDb(async (db, sm) => {
        db.initDb();
        db.createTask({
          id: "task-sm-011",
          title: "多日志测试",
          workflow: "test",
          initialStatus: "pending",
        });

        sm.transition("task-sm-011", "start", { transitions: TRANSITIONS });
        sm.transition("task-sm-011", "complete", { transitions: TRANSITIONS });

        const logs = db.getTaskLogs("task-sm-011");
        expect(logs.length).toBe(2);
      });
    });

    it("note 为空时日志的 note 字段应为 null", async () => {
      await withTestDb(async (db, sm) => {
        db.initDb();
        db.createTask({
          id: "task-sm-012",
          title: "无备注日志测试",
          workflow: "test",
          initialStatus: "pending",
        });

        sm.transition("task-sm-012", "start", { transitions: TRANSITIONS });

        const logs = db.getTaskLogs("task-sm-012");
        expect(logs[0].note).toBeNull();
      });
    });
  });

  describe("transition - extraUpdates 合并", () => {
    it("列字段应直接更新到对应列", async () => {
      await withTestDb(async (db, sm) => {
        db.initDb();
        db.createTask({
          id: "task-sm-013",
          title: "extraUpdates 列字段测试",
          workflow: "test",
          initialStatus: "pending",
        });

        sm.transition("task-sm-013", "start", {
          transitions: TRANSITIONS,
          extraUpdates: { failure_count: 2 },
        });

        const task = db.getTask("task-sm-013");
        expect(task!.failure_count).toBe(2);
      });
    });

    it("非列字段应合并到 extra JSON", async () => {
      await withTestDb(async (db, sm) => {
        db.initDb();
        db.createTask({
          id: "task-sm-014",
          title: "extraUpdates extra 合并测试",
          workflow: "test",
          initialStatus: "pending",
          extra: { existing_key: "existing_value" },
        });

        sm.transition("task-sm-014", "start", {
          transitions: TRANSITIONS,
          extraUpdates: { pr_url: "https://github.com/pr/99" },
        });

        const task = db.getTask("task-sm-014");
        expect(task!.pr_url).toBe("https://github.com/pr/99");
        expect(task!.existing_key).toBe("existing_value");
      });
    });

    it("同时包含列字段和非列字段时均应正确更新", async () => {
      await withTestDb(async (db, sm) => {
        db.initDb();
        db.createTask({
          id: "task-sm-015",
          title: "混合 extraUpdates 测试",
          workflow: "test",
          initialStatus: "pending",
        });

        sm.transition("task-sm-015", "start", {
          transitions: TRANSITIONS,
          extraUpdates: {
            failure_count: 3,
            branch: "feat/test",
          },
        });

        const task = db.getTask("task-sm-015");
        expect(task!.failure_count).toBe(3);
        expect(task!.branch).toBe("feat/test");
        expect(task!.status).toBe("running_phase1");
      });
    });
  });
});
