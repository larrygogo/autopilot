import type { Database } from "bun:sqlite";

/**
 * 简单键值表：用于持久化跨进程的小状态（如 setup.dismissed）。
 * 不替代任何业务表；仅在没必要为一两个字段专门建表时使用。
 */
export function up(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}
