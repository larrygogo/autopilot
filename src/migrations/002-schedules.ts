import type { Database } from "bun:sqlite";

/**
 * 添加 schedules 表：用于定时创建任务。
 *
 * - type='once'  → 一次性，使用 run_at；触发后 enabled 自动置 0。
 * - type='cron'  → 周期性，使用 cron_expr；每次触发后重算 next_run_at。
 *
 * 不做并发保护：上一次任务是否结束与下次触发无关。
 * 用户通过 enabled 开关随时停用 / 启用一个 schedule。
 */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      run_at TEXT,
      cron_expr TEXT,
      timezone TEXT NOT NULL,
      workflow TEXT NOT NULL,
      title TEXT NOT NULL,
      requirement TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      next_run_at TEXT,
      last_run_at TEXT,
      last_task_id TEXT,
      run_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_schedules_enabled_next
      ON schedules (enabled, next_run_at);
    CREATE INDEX IF NOT EXISTS idx_schedules_workflow
      ON schedules (workflow);
  `);
}
