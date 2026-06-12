/**
 * 移除 cron 定时任务（schedules）功能。
 * 删除 schedules 表及其索引。
 */
import type { Database } from "bun:sqlite";

export function up(db: Database): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_schedules_enabled_next;
    DROP INDEX IF EXISTS idx_schedules_workflow;
    DROP INDEX IF EXISTS idx_schedules_target_task;
    DROP TABLE IF EXISTS schedules;
  `);
}
