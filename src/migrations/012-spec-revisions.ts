import type { Database } from "bun:sqlite";

/**
 * 创建 spec_revisions 表：保留 requirement.spec_md 每次修订的 before/after 全文 + 摘要。
 * 用于澄清过程中 AI 持续修订 spec_md 的历史回溯。
 */
export function up(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS spec_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      requirement_id TEXT NOT NULL,
      before_md TEXT NOT NULL,
      after_md TEXT NOT NULL,
      summary TEXT,
      source TEXT NOT NULL,
      triggered_by_question_id TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (requirement_id) REFERENCES requirements(id) ON DELETE CASCADE
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_spec_revisions_req ON spec_revisions(requirement_id, created_at)");
}
