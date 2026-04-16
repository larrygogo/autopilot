import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { join } from "path";
import { AUTOPILOT_HOME } from "../index";

// ──────────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────────

export interface Task {
  id: string;
  title: string;
  workflow: string;
  status: string;
  failure_count: number;
  channel: string;
  notify_target: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  parent_task_id: string | null;
  parallel_index: number | null;
  parallel_group: string | null;
  [key: string]: unknown;
}

export interface TaskLog {
  id: number;
  task_id: string;
  from_status: string | null;
  to_status: string;
  trigger_name: string | null;
  note: string | null;
  created_at: string;
}

// ──────────────────────────────────────────────
// Schema
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

// tasks 表中实际存在的列字段（用于区分列字段和 extra JSON 字段）
const TABLE_COLUMNS = new Set([
  "id",
  "title",
  "workflow",
  "status",
  "failure_count",
  "channel",
  "notify_target",
  "extra",
  "created_at",
  "updated_at",
  "started_at",
  "parent_task_id",
  "parallel_index",
  "parallel_group",
]);

// ──────────────────────────────────────────────
// 数据库单例
// ──────────────────────────────────────────────

let _db: Database | null = null;

export function getDb(): Database {
  if (!_db) {
    const runtimeDir = join(AUTOPILOT_HOME, "runtime");
    mkdirSync(runtimeDir, { recursive: true });
    const dbPath = join(runtimeDir, "workflow.db");
    _db = new Database(dbPath);
  }
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/** 仅供测试使用：注入外部 Database 实例 */
export function _setDbForTest(db: Database | null): void {
  _db = db;
}

export function initDb(): void {
  const db = getDb();
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA foreign_keys=ON");
  db.exec(SCHEMA);
}

export function now(): string {
  return new Date().toISOString();
}

// ──────────────────────────────────────────────
// 内部辅助
// ──────────────────────────────────────────────

interface RawRow {
  extra?: string | null;
  [key: string]: unknown;
}

function rowToTask(row: RawRow): Task {
  const { extra, ...rest } = row;
  let extraObj: Record<string, unknown> = {};
  try {
    extraObj = extra ? (JSON.parse(extra as string) as Record<string, unknown>) : {};
  } catch {
    extraObj = {};
  }
  // extra 中的 key 不覆盖列字段
  const merged: Record<string, unknown> = { ...extraObj };
  for (const [k, v] of Object.entries(rest)) {
    merged[k] = v;
  }
  return merged as unknown as Task;
}

// ──────────────────────────────────────────────
// CRUD
// ──────────────────────────────────────────────

export function getTask(taskId: string): Task | null {
  const db = getDb();
  const row = db
    .query<RawRow, [string]>("SELECT * FROM tasks WHERE id = ?")
    .get(taskId);
  return row ? rowToTask(row) : null;
}

export interface CreateTaskOpts {
  id: string;
  title: string;
  workflow: string;
  initialStatus: string;
  channel?: string;
  notifyTarget?: string | null;
  extra?: Record<string, unknown>;
}

export function createTask(opts: CreateTaskOpts): void {
  const db = getDb();
  const ts = now();
  db.run(
    "INSERT INTO tasks" +
    " (id, title, workflow, status, channel, notify_target, extra, created_at, updated_at)" +
    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      opts.id,
      opts.title,
      opts.workflow,
      opts.initialStatus,
      opts.channel ?? "log",
      opts.notifyTarget ?? null,
      JSON.stringify(opts.extra ?? {}),
      ts,
      ts,
    ]
  );
}

export function updateTask(
  taskId: string,
  fields: Record<string, unknown>
): void {
  const db = getDb();

  const colUpdates: string[] = [];
  const colValues: unknown[] = [];
  const extraUpdates: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(fields)) {
    if (key === "extra") continue;
    if (TABLE_COLUMNS.has(key)) {
      colUpdates.push(key + " = ?");
      colValues.push(value);
    } else {
      extraUpdates[key] = value;
    }
  }

  const hasExtraUpdates = Object.keys(extraUpdates).length > 0;

  if (!hasExtraUpdates && colUpdates.length === 0) return;

  if (hasExtraUpdates) {
    // 使用事务保证 extra 字段合并的原子性
    db.transaction(() => {
      const row = db
        .query<{ extra: string | null }, [string]>(
          "SELECT extra FROM tasks WHERE id = ?"
        )
        .get(taskId);
      let currentExtra: Record<string, unknown> = {};
      try {
        currentExtra = row?.extra ? JSON.parse(row.extra) : {};
      } catch {
        currentExtra = {};
      }
      const mergedExtra = { ...currentExtra, ...extraUpdates };

      colUpdates.push("extra = ?");
      colValues.push(JSON.stringify(mergedExtra));
      colUpdates.push("updated_at = ?");
      colValues.push(now());
      colValues.push(taskId);

      db.run(
        "UPDATE tasks SET " + colUpdates.join(", ") + " WHERE id = ?",
        colValues as Parameters<typeof db.run>[1]
      );
    })();
  } else {
    colUpdates.push("updated_at = ?");
    colValues.push(now());
    colValues.push(taskId);

    db.run(
      "UPDATE tasks SET " + colUpdates.join(", ") + " WHERE id = ?",
      colValues as Parameters<typeof db.run>[1]
    );
  }
}

export interface ListTasksFilters {
  status?: string;
  workflow?: string;
  limit?: number;
}

export function listTasks(filters: ListTasksFilters = {}): Task[] {
  const db = getDb();
  const conditions: string[] = [];
  const values: any[] = [];

  if (filters.status !== undefined) {
    conditions.push("status = ?");
    values.push(filters.status);
  }
  if (filters.workflow !== undefined) {
    conditions.push("workflow = ?");
    values.push(filters.workflow);
  }

  const where = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";
  const limitClause = filters.limit !== undefined ? "LIMIT " + Number(filters.limit) : "";

  const rows = db
    .query<RawRow, any[]>(
      "SELECT * FROM tasks " + where + " ORDER BY created_at DESC " + limitClause
    )
    .all(...values);

  return rows.map(rowToTask);
}

export function getTaskLogs(
  taskId: string,
  limit = 100
): Record<string, unknown>[] {
  const db = getDb();
  return db
    .query<Record<string, unknown>, [string, number]>(
      "SELECT * FROM task_logs WHERE task_id = ? ORDER BY id DESC LIMIT ?"
    )
    .all(taskId, limit);
}

// ──────────────────────────────────────────────
// 子任务（并行支持）
// ──────────────────────────────────────────────

export interface CreateSubTaskOpts {
  parentTaskId: string;
  subTaskId: string;
  phaseName: string;
  parallelGroup: string;
  parallelIndex: number;
  initialStatus?: string;
}

export function createSubTask(opts: CreateSubTaskOpts): void {
  const db = getDb();
  const parent = getTask(opts.parentTaskId);
  if (!parent) throw new Error("父任务不存在：" + opts.parentTaskId);

  // 继承父任务的 extra 字段（只取非列字段部分）
  const parentExtra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parent)) {
    if (!TABLE_COLUMNS.has(key) && key !== "extra") {
      parentExtra[key] = value;
    }
  }

  const ts = now();
  db.run(
    "INSERT OR IGNORE INTO tasks" +
    " (id, title, workflow, status, channel, notify_target, extra," +
    "  created_at, updated_at, parent_task_id, parallel_index, parallel_group)" +
    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      opts.subTaskId,
      opts.phaseName,
      parent.workflow,
      opts.initialStatus ?? "pending",
      parent.channel,
      parent.notify_target ?? null,
      JSON.stringify(parentExtra),
      ts,
      ts,
      opts.parentTaskId,
      opts.parallelIndex,
      opts.parallelGroup,
    ]
  );
}

export function getSubTasks(parentTaskId: string): Task[] {
  const db = getDb();
  const rows = db
    .query<RawRow, [string]>(
      "SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY parallel_index ASC"
    )
    .all(parentTaskId);
  return rows.map(rowToTask);
}
