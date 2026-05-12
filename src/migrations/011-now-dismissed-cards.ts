import type { Database } from "bun:sqlite";

/**
 * /now 卡片 dismiss 持久化表。
 * card_id 形如 "completed:task-5"、"task-failed:task-7"，由各 CardSource 生成。
 */
export function up(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS now_dismissed_cards (
      card_id TEXT NOT NULL PRIMARY KEY,
      dismissed_at INTEGER NOT NULL
    )
  `);
}
