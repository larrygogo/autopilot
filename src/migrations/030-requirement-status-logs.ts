import type { Database } from "bun:sqlite";

/** 需求级状态转移日志（与 task_logs 对称）：每次 setRequirementStatus 写一行。
 *  服务于：审批/排队等步骤 tab 显示真实时间点、终态死亡步推导、长期需求审计。
 *  历史转移无从回填（此前没有记录），新转移起算。 */
export function up(db: Database): void {
  db.run(
    `CREATE TABLE IF NOT EXISTS requirement_status_logs (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       requirement_id TEXT NOT NULL,
       from_status TEXT NOT NULL,
       to_status TEXT NOT NULL,
       reason TEXT DEFAULT NULL,
       created_at INTEGER NOT NULL
     )`,
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_requirement_status_logs_req ON requirement_status_logs (requirement_id)",
  );
}
