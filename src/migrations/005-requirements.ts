import type { Database } from "bun:sqlite";

/**
 * 添加 requirements 和 requirement_feedbacks 表，支持「需求队列」工作模式（Phase 2 起）。
 *
 * Schema 一次到位：含 P3/P4 才用的 last_reviewed_event_id（gh CLI 轮询去重用），
 * 避免反复 migration。
 *
 * 时间戳用 INTEGER（epoch ms），跟 tasks/schedules 用 TEXT 不同；
 * 与 repos 表（P1 加入）保持一致。
 */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS requirements (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL REFERENCES repos(id),
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      spec_md TEXT NOT NULL DEFAULT '',
      chat_session_id TEXT,
      task_id TEXT,
      pr_url TEXT,
      pr_number INTEGER,
      last_reviewed_event_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_requirements_repo ON requirements(repo_id);
    CREATE INDEX IF NOT EXISTS idx_requirements_status ON requirements(status);
    CREATE INDEX IF NOT EXISTS idx_requirements_repo_status ON requirements(repo_id, status);

    CREATE TABLE IF NOT EXISTS requirement_feedbacks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      requirement_id TEXT NOT NULL REFERENCES requirements(id),
      source TEXT NOT NULL,
      body TEXT NOT NULL,
      github_review_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_feedbacks_req ON requirement_feedbacks(requirement_id);
  `);
}
