import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { _setDbForTest, getWorkflowPhaseStats } from "../src/core/db";

function insertTask(db: Database, id: string, workflow: string) {
  db.run(
    "INSERT INTO tasks (id, title, workflow, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    [id, id, workflow, "done", new Date().toISOString(), new Date().toISOString()],
  );
}

/** 用最小化 schema 跑——只准备 tasks + task_phase_events 两张表，避开完整 migration 链 */
function makeTestDb(): Database {
  const db = new Database(":memory:");
  // tasks 表（截到 getWorkflowPhaseStats 用得到的字段）
  db.run(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT,
      workflow TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      requirement TEXT,
      requirement_id TEXT,
      extra TEXT
    )
  `);
  db.run(`
    CREATE TABLE task_phase_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER
    )
  `);
  return db;
}

function insertEvent(db: Database, taskId: string, phase: string, startedAt: number, durMs: number, status = "done") {
  db.run(
    "INSERT INTO task_phase_events (task_id, phase, status, started_at, ended_at) VALUES (?, ?, ?, ?, ?)",
    [taskId, phase, status, startedAt, startedAt + durMs],
  );
}

describe("getWorkflowPhaseStats", () => {
  let db: Database;

  beforeEach(() => {
    db = makeTestDb();
    _setDbForTest(db);
  });

  afterEach(() => {
    _setDbForTest(null);
    db.close();
  });

  it("空表 → 返回空对象", () => {
    expect(getWorkflowPhaseStats("dev")).toEqual({});
  });

  it("单 phase 多样本 → P50 = 中位数", () => {
    insertTask(db, "t1", "dev");
    insertTask(db, "t2", "dev");
    insertTask(db, "t3", "dev");
    insertEvent(db, "t1", "design", 1000, 2000);
    insertEvent(db, "t2", "design", 2000, 4000);
    insertEvent(db, "t3", "design", 3000, 6000);
    const stats = getWorkflowPhaseStats("dev");
    expect(stats.design?.count).toBe(3);
    expect(stats.design?.p50_ms).toBe(4000); // 排序 [2000, 4000, 6000] → 中位 4000
  });

  it("偶数样本 → P50 = 两中位平均", () => {
    insertTask(db, "t1", "dev");
    insertTask(db, "t2", "dev");
    insertEvent(db, "t1", "design", 1000, 2000);
    insertEvent(db, "t2", "design", 2000, 4000);
    const stats = getWorkflowPhaseStats("dev");
    expect(stats.design?.p50_ms).toBe(3000); // (2000+4000)/2
  });

  it("不同 workflow 互不干扰", () => {
    insertTask(db, "t1", "dev");
    insertTask(db, "t2", "docs");
    insertEvent(db, "t1", "design", 1000, 1000);
    insertEvent(db, "t2", "design", 1000, 9999);
    const devStats = getWorkflowPhaseStats("dev");
    const docsStats = getWorkflowPhaseStats("docs");
    expect(devStats.design?.p50_ms).toBe(1000);
    expect(docsStats.design?.p50_ms).toBe(9999);
  });

  it("非 done / 未结束的事件不计入", () => {
    insertTask(db, "t1", "dev");
    insertTask(db, "t2", "dev");
    insertEvent(db, "t1", "design", 1000, 5000, "done");
    insertEvent(db, "t2", "design", 1000, 999, "failed");      // failed 不计
    insertEvent(db, "t2", "design", 2000, 0, "running");       // running 不计（ended_at = 0 但 status 不是 done）
    // running 状态 + ended_at 不为 null 也不计入，因为 status='done' 过滤
    db.run(
      "INSERT INTO task_phase_events (task_id, phase, status, started_at, ended_at) VALUES (?, ?, 'running', ?, NULL)",
      ["t2", "design", 3000],
    );
    const stats = getWorkflowPhaseStats("dev");
    expect(stats.design?.count).toBe(1);
    expect(stats.design?.p50_ms).toBe(5000);
  });
});
