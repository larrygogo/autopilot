import type { Database } from "bun:sqlite";

/**
 * 通知表 —— 事件型通知流（替代「Now 决策收件箱」的派生快照模型）。
 * - append-only：领域事件发生时写入，状态后续变化不抹历史
 * - read_at / dismissed_at 双状态独立（已读 ≠ 删除）
 * - context_json / actions_json 写入时快照（不依赖后续 JOIN，实体删了通知仍可读）
 * - 不回填历史（与 030 同口径：历史事件无从回填，新事件起算）
 */
export function up(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS notifications (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      type          TEXT NOT NULL,
      severity      TEXT NOT NULL,
      title         TEXT NOT NULL,
      body          TEXT NOT NULL DEFAULT '',
      related_type  TEXT DEFAULT NULL,
      related_id    TEXT DEFAULT NULL,
      context_json  TEXT DEFAULT NULL,
      actions_json  TEXT DEFAULT NULL,
      read_at       INTEGER DEFAULT NULL,
      dismissed_at  INTEGER DEFAULT NULL,
      created_at    INTEGER NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_notif_unread ON notifications (read_at) WHERE read_at IS NULL`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_notif_created ON notifications (created_at DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_notif_related ON notifications (related_type, related_id)`);
}
