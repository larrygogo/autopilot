import type { Database } from "bun:sqlite";

/**
 * 多 PR 评审水位：requirements.last_reviewed_event_id 是单值，多代码库需求
 * 各交付 PR 需独立去重水位。加在 requirement_sub_prs（多库时该表 = 交付 PR 全集）。
 * 幂等：PRAGMA 列检查。
 */
export function up(db: Database): void {
  const hasTable = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='requirement_sub_prs'",
    )
    .get();
  if (!hasTable) return;
  const cols = db.query<{ name: string }, []>("PRAGMA table_info(requirement_sub_prs)").all();
  if (!cols.some((c) => c.name === "last_reviewed_event_id")) {
    db.run("ALTER TABLE requirement_sub_prs ADD COLUMN last_reviewed_event_id TEXT");
  }
}
