import type { Database } from "bun:sqlite";

/**
 * 基线迁移：幂等创建 tasks + task_logs 表及索引。
 * 与 db.ts 中的 SCHEMA 保持一致。
 */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      workflow TEXT NOT NULL,
      status TEXT NOT NULL,
      failure_count INTEGER DEFAULT 0,
      channel TEXT DEFAULT 'log',
      notify_target TEXT,
      extra TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      parent_task_id TEXT DEFAULT NULL,
      parallel_index INTEGER DEFAULT NULL,
      parallel_group TEXT DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS task_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      trigger_name TEXT,
      note TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_workflow ON tasks (workflow);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status);
    CREATE INDEX IF NOT EXISTS idx_task_logs_task_id ON task_logs (task_id);
  `);
}
