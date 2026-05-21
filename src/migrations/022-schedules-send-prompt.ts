import type { Database } from "bun:sqlite";

/**
 * Phase 5 — schedules 加 send_prompt mode（spec §3.6 / §4.2）。
 *
 * 老 schedule 行为不变：mode 默认 'start_task'，fireSchedule 仍走 startTaskFromTemplate。
 * 新行为 mode='send_prompt'：fireSchedule 调 sendPromptToTask(target_task_id, prompt)。
 *
 * 字段：
 *   mode            TEXT NOT NULL DEFAULT 'start_task'  -- start_task / send_prompt
 *   target_task_id  TEXT NULL                            -- mode=send_prompt 时必填
 *   prompt          TEXT NULL                            -- mode=send_prompt 时必填（含占位符）
 */
export function up(db: Database): void {
  const cols = db.query<{ name: string }, []>("PRAGMA table_info(schedules)").all().map(c => c.name);
  if (!cols.includes("mode")) {
    db.run("ALTER TABLE schedules ADD COLUMN mode TEXT NOT NULL DEFAULT 'start_task'");
  }
  if (!cols.includes("target_task_id")) {
    db.run("ALTER TABLE schedules ADD COLUMN target_task_id TEXT");
  }
  if (!cols.includes("prompt")) {
    db.run("ALTER TABLE schedules ADD COLUMN prompt TEXT");
  }
  db.run("CREATE INDEX IF NOT EXISTS idx_schedules_target_task ON schedules(target_task_id)");
}
