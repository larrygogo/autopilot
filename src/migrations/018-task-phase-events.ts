import type { Database } from "bun:sqlite";

/**
 * 持久化每个 task phase 的起止时间与状态。
 *
 * 同一 (task_id, phase) 可有多行：重试 / 驳回回滚时再次进入同 phase 会新建 event。
 * status: 'running' / 'done' / 'awaiting' / 'failed'
 *   - awaiting：phase 函数完成后挂到 awaiting_<phase> 等用户决断（gate=true）
 *   - done：phase 函数完成并自动 transition 到下一 phase
 */
export function up(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS task_phase_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_phase_events_task ON task_phase_events (task_id, started_at)`);
}
