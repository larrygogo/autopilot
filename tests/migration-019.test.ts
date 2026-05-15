import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { up } from "../src/migrations/019-task-requirement-id";

describe("migration 019: tasks.requirement_id", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    // 建测试 schema：模拟 migration 018 之后的状态（tasks 表无 requirement_id，requirements 表有 task_id）
    db.run(
      `CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        workflow TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    );
    db.run(
      `CREATE TABLE requirements (
        id TEXT PRIMARY KEY,
        title TEXT,
        task_id TEXT,
        status TEXT
      )`,
    );
  });

  it("加 requirement_id 列 + 索引", async () => {
    await up(db);
    const cols = db.query<{ name: string }, []>("PRAGMA table_info(tasks)").all();
    const names = cols.map((c) => c.name);
    expect(names).toContain("requirement_id");

    // 索引存在
    const indexes = db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tasks'",
    ).all();
    expect(indexes.some((i) => i.name === "idx_tasks_requirement_id")).toBe(true);
  });

  it("已有列时幂等（多次跑不报错）", async () => {
    await up(db);
    await up(db); // 再跑一次
    const cols = db.query<{ name: string }, []>("PRAGMA table_info(tasks)").all();
    expect(cols.filter((c) => c.name === "requirement_id").length).toBe(1);
  });

  it("回填：requirements.task_id → tasks.requirement_id 反向写回", async () => {
    db.run(
      "INSERT INTO tasks (id, title, workflow, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["task-001", "T1", "dev", "running_design", "2026-01-01", "2026-01-01"],
    );
    db.run(
      "INSERT INTO tasks (id, title, workflow, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["task-002", "T2", "dev", "done", "2026-01-02", "2026-01-02"],
    );
    db.run(
      "INSERT INTO requirements (id, title, task_id, status) VALUES (?, ?, ?, ?)",
      ["req-001", "需求 1", "task-001", "running"],
    );
    db.run(
      "INSERT INTO requirements (id, title, task_id, status) VALUES (?, ?, ?, ?)",
      ["req-002", "需求 2", null, "draft"], // 无 task_id 关联
    );

    await up(db);

    const t1 = db.query<{ requirement_id: string | null }, [string]>(
      "SELECT requirement_id FROM tasks WHERE id = ?",
    ).get("task-001");
    expect(t1?.requirement_id).toBe("req-001");

    const t2 = db.query<{ requirement_id: string | null }, [string]>(
      "SELECT requirement_id FROM tasks WHERE id = ?",
    ).get("task-002");
    // task-002 没被任何 requirement 引用 → requirement_id 仍为 null
    expect(t2?.requirement_id).toBeNull();
  });

  it("requirements 表不存在时（极端场景，老 DB）不抛错", async () => {
    db.run("DROP TABLE requirements");
    await up(db);
    // 列仍添加成功
    const cols = db.query<{ name: string }, []>("PRAGMA table_info(tasks)").all();
    expect(cols.some((c) => c.name === "requirement_id")).toBe(true);
  });

  it("回填不覆盖已有值（幂等保护）", async () => {
    // 先跑一次加列
    await up(db);
    // 手工写一个已经有 requirement_id 的 task
    db.run(
      "INSERT INTO tasks (id, title, workflow, status, requirement_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["task-pre", "T_pre", "dev", "done", "req-explicit", "2026-01-01", "2026-01-01"],
    );
    db.run(
      "INSERT INTO requirements (id, title, task_id, status) VALUES (?, ?, ?, ?)",
      ["req-other", "其它", "task-pre", "running"],
    );

    // 再跑一次回填，不应覆盖 req-explicit
    await up(db);
    const t = db.query<{ requirement_id: string | null }, [string]>(
      "SELECT requirement_id FROM tasks WHERE id = ?",
    ).get("task-pre");
    expect(t?.requirement_id).toBe("req-explicit");
  });
});
