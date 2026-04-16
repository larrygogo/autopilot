import { describe, it, expect } from "bun:test";

// 每个测试用内存 SQLite + 注入钩子保证隔离
async function withTestDb<T>(
  fn: (db: typeof import("../src/core/db")) => T | Promise<T>
): Promise<T> {
  const { Database } = await import("bun:sqlite");
  const sqlite = new Database(":memory:");

  const schemaParts = [
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
  ];

  sqlite.run("PRAGMA journal_mode=WAL");
  sqlite.run("PRAGMA foreign_keys=ON");
  sqlite.exec(schemaParts.join("\n"));

  const dbModule = await import("../src/core/db");
  (dbModule as any)._setDbForTest(sqlite);

  try {
    return await fn(dbModule);
  } finally {
    (dbModule as any)._setDbForTest(null);
    sqlite.close();
  }
}

describe("db 模块", () => {
  describe("initDb - 创建数据库表", () => {
    it("应当创建 tasks 和 task_logs 表", async () => {
      const { Database } = await import("bun:sqlite");
      const sqlite = new Database(":memory:");
      const dbModule = await import("../src/core/db");
      (dbModule as any)._setDbForTest(sqlite);

      try {
        dbModule.initDb();
        const tables = sqlite
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
          )
          .all();
        const names = tables.map((t) => t.name);
        expect(names).toContain("tasks");
        expect(names).toContain("task_logs");
      } finally {
        (dbModule as any)._setDbForTest(null);
        sqlite.close();
      }
    });
  });

  describe("createTask + getTask - roundtrip", () => {
    it("应当正确存储并读取所有字段", async () => {
      await withTestDb(async (db) => {
        db.initDb();
        db.createTask({
          id: "task-001",
          title: "测试任务",
          workflow: "dev",
          initialStatus: "pending",
          channel: "webhook",
          notifyTarget: "https://example.com/hook",
          extra: { pr_url: "https://github.com/pr/1", branch: "main" },
        });

        const task = db.getTask("task-001");
        expect(task).not.toBeNull();
        expect(task!.id).toBe("task-001");
        expect(task!.title).toBe("测试任务");
        expect(task!.workflow).toBe("dev");
        expect(task!.status).toBe("pending");
        expect(task!.channel).toBe("webhook");
        expect(task!.notify_target).toBe("https://example.com/hook");
        expect(task!.failure_count).toBe(0);
        expect(task!.started_at).toBeNull();
        expect(task!.parent_task_id).toBeNull();
        expect(task!.parallel_index).toBeNull();
        expect(task!.parallel_group).toBeNull();
        // extra 字段展开验证
        expect(task!.pr_url).toBe("https://github.com/pr/1");
        expect(task!.branch).toBe("main");
      });
    });

    it("不存在的任务应当返回 null", async () => {
      await withTestDb(async (db) => {
        db.initDb();
        expect(db.getTask("nonexistent")).toBeNull();
      });
    });

    it("channel 和 extra 应有默认值", async () => {
      await withTestDb(async (db) => {
        db.initDb();
        db.createTask({
          id: "task-002",
          title: "默认值测试",
          workflow: "simple",
          initialStatus: "running",
        });
        const task = db.getTask("task-002");
        expect(task!.channel).toBe("log");
        expect(task!.notify_target).toBeNull();
      });
    });
  });

  describe("updateTask - 字段更新", () => {
    it("应当更新列字段", async () => {
      await withTestDb(async (db) => {
        db.initDb();
        db.createTask({
          id: "task-003",
          title: "更新测试",
          workflow: "dev",
          initialStatus: "pending",
        });
        db.updateTask("task-003", { status: "running" });
        expect(db.getTask("task-003")!.status).toBe("running");
      });
    });

    it("应当合并 extra 字段而不是覆盖", async () => {
      await withTestDb(async (db) => {
        db.initDb();
        db.createTask({
          id: "task-004",
          title: "extra 合并测试",
          workflow: "dev",
          initialStatus: "pending",
          extra: { key1: "value1", key2: "value2" },
        });
        db.updateTask("task-004", { key3: "value3" });

        const task = db.getTask("task-004");
        expect(task!.key1).toBe("value1");
        expect(task!.key2).toBe("value2");
        expect(task!.key3).toBe("value3");
      });
    });

    it("extra 中的 key 不应覆盖列字段", async () => {
      await withTestDb(async (db) => {
        db.initDb();
        db.createTask({
          id: "task-005",
          title: "覆盖保护测试",
          workflow: "dev",
          initialStatus: "pending",
          extra: { status: "SHOULD_NOT_OVERRIDE" },
        });
        // 列字段 status 应该是 "pending"，不被 extra 中的 status 覆盖
        expect(db.getTask("task-005")!.status).toBe("pending");
      });
    });

    it("应当同时更新列字段和 extra 字段", async () => {
      await withTestDb(async (db) => {
        db.initDb();
        db.createTask({
          id: "task-006",
          title: "混合更新测试",
          workflow: "dev",
          initialStatus: "pending",
          extra: { existing: "old" },
        });
        db.updateTask("task-006", { status: "running", newExtraKey: "newValue" });

        const task = db.getTask("task-006");
        expect(task!.status).toBe("running");
        expect(task!.existing).toBe("old");
        expect(task!.newExtraKey).toBe("newValue");
      });
    });
  });

  describe("listTasks - 过滤查询", () => {
    it("无过滤条件应返回所有任务", async () => {
      await withTestDb(async (db) => {
        db.initDb();
        db.createTask({ id: "t1", title: "T1", workflow: "wf1", initialStatus: "pending" });
        db.createTask({ id: "t2", title: "T2", workflow: "wf2", initialStatus: "running" });
        db.createTask({ id: "t3", title: "T3", workflow: "wf1", initialStatus: "done" });
        expect(db.listTasks().length).toBe(3);
      });
    });

    it("按 status 过滤", async () => {
      await withTestDb(async (db) => {
        db.initDb();
        db.createTask({ id: "t1", title: "T1", workflow: "wf1", initialStatus: "pending" });
        db.createTask({ id: "t2", title: "T2", workflow: "wf2", initialStatus: "running" });
        db.createTask({ id: "t3", title: "T3", workflow: "wf1", initialStatus: "pending" });

        const tasks = db.listTasks({ status: "pending" });
        expect(tasks.length).toBe(2);
        for (const t of tasks) expect(t.status).toBe("pending");
      });
    });

    it("按 workflow 过滤", async () => {
      await withTestDb(async (db) => {
        db.initDb();
        db.createTask({ id: "t1", title: "T1", workflow: "wf1", initialStatus: "pending" });
        db.createTask({ id: "t2", title: "T2", workflow: "wf2", initialStatus: "running" });
        db.createTask({ id: "t3", title: "T3", workflow: "wf1", initialStatus: "done" });

        const tasks = db.listTasks({ workflow: "wf1" });
        expect(tasks.length).toBe(2);
        for (const t of tasks) expect(t.workflow).toBe("wf1");
      });
    });

    it("按 status 和 workflow 组合过滤", async () => {
      await withTestDb(async (db) => {
        db.initDb();
        db.createTask({ id: "t1", title: "T1", workflow: "wf1", initialStatus: "pending" });
        db.createTask({ id: "t2", title: "T2", workflow: "wf2", initialStatus: "pending" });
        db.createTask({ id: "t3", title: "T3", workflow: "wf1", initialStatus: "done" });

        const tasks = db.listTasks({ status: "pending", workflow: "wf1" });
        expect(tasks.length).toBe(1);
        expect(tasks[0].id).toBe("t1");
      });
    });

    it("limit 限制返回数量", async () => {
      await withTestDb(async (db) => {
        db.initDb();
        for (let i = 0; i < 5; i++) {
          db.createTask({ id: "t" + i, title: "T" + i, workflow: "wf", initialStatus: "pending" });
        }
        expect(db.listTasks({ limit: 3 }).length).toBe(3);
      });
    });
  });

  describe("createSubTask - 子任务继承", () => {
    it("应当创建子任务并继承父任务信息", async () => {
      await withTestDb(async (db) => {
        db.initDb();
        db.createTask({
          id: "parent-001",
          title: "父任务",
          workflow: "parallel_build",
          initialStatus: "running",
          channel: "webhook",
          notifyTarget: "https://example.com/hook",
          extra: { pr_url: "https://github.com/pr/42" },
        });

        db.createSubTask({
          parentTaskId: "parent-001",
          subTaskId: "sub-001-frontend",
          phaseName: "frontend",
          parallelGroup: "development",
          parallelIndex: 0,
          initialStatus: "pending",
        });

        const sub = db.getTask("sub-001-frontend");
        expect(sub).not.toBeNull();
        expect(sub!.id).toBe("sub-001-frontend");
        expect(sub!.title).toBe("frontend");
        expect(sub!.workflow).toBe("parallel_build");
        expect(sub!.status).toBe("pending");
        expect(sub!.channel).toBe("webhook");
        expect(sub!.notify_target).toBe("https://example.com/hook");
        expect(sub!.parent_task_id).toBe("parent-001");
        expect(sub!.parallel_index).toBe(0);
        expect(sub!.parallel_group).toBe("development");
        // 继承父任务 extra 中的自定义字段
        expect(sub!.pr_url).toBe("https://github.com/pr/42");
      });
    });

    it("getSubTasks 应按 parallel_index 排序返回子任务", async () => {
      await withTestDb(async (db) => {
        db.initDb();
        db.createTask({
          id: "parent-002",
          title: "父任务2",
          workflow: "parallel_build",
          initialStatus: "running",
        });

        // 故意先插入 index=1
        db.createSubTask({
          parentTaskId: "parent-002",
          subTaskId: "sub-002-b",
          phaseName: "backend",
          parallelGroup: "dev",
          parallelIndex: 1,
        });
        db.createSubTask({
          parentTaskId: "parent-002",
          subTaskId: "sub-002-f",
          phaseName: "frontend",
          parallelGroup: "dev",
          parallelIndex: 0,
        });

        const subs = db.getSubTasks("parent-002");
        expect(subs.length).toBe(2);
        expect(subs[0].parallel_index).toBe(0);
        expect(subs[0].title).toBe("frontend");
        expect(subs[1].parallel_index).toBe(1);
        expect(subs[1].title).toBe("backend");
      });
    });

    it("父任务不存在时应抛出错误", async () => {
      await withTestDb(async (db) => {
        db.initDb();
        expect(() => {
          db.createSubTask({
            parentTaskId: "nonexistent-parent",
            subTaskId: "sub-x",
            phaseName: "phase",
            parallelGroup: "group",
            parallelIndex: 0,
          });
        }).toThrow();
      });
    });
  });
});
