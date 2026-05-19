import type { Database } from "bun:sqlite";

/**
 * 用户表：存储 email/password_hash，用于 Web UI 的邮箱+密码+JWT cookie 登录流程。
 * 若表中无记录，auth 处于禁用状态（兼容旧版 API token 模式）。
 */
export function up(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}
