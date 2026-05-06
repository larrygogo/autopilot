import type { Database } from "bun:sqlite";

/**
 * 添加 submodule 支持：
 *   - repos 表加 parent_repo_id（关联父 repo）+ submodule_path（父 repo 内相对路径）
 *   - 新增 requirement_sub_prs 表，记录一个需求关联的多个子模块 PR
 *
 * P1 引入的 repos 表结构沿用，新字段 NULL 表示该 repo 是顶级父 repo。
 */
export function up(db: Database): void {
  db.exec(`
    ALTER TABLE repos ADD COLUMN parent_repo_id TEXT REFERENCES repos(id);
    ALTER TABLE repos ADD COLUMN submodule_path TEXT;

    CREATE TABLE IF NOT EXISTS requirement_sub_prs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      requirement_id TEXT NOT NULL REFERENCES requirements(id),
      child_repo_id TEXT NOT NULL REFERENCES repos(id),
      pr_url TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(requirement_id, child_repo_id)
    );
    CREATE INDEX IF NOT EXISTS idx_sub_prs_req ON requirement_sub_prs(requirement_id);
  `);
}
