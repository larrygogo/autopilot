import type { Database } from "bun:sqlite";

/**
 * 添加 repos 表：仓库目录中心，支持需求队列模式下的 per-task 仓库绑定。
 *
 * - alias：用户起的短名，UNIQUE，用于 chat 引用
 * - path：仓库绝对路径
 * - github_owner / github_repo：可选，从 git remote 自动解析或手填，gh CLI 操作时使用
 */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS repos (
      id TEXT PRIMARY KEY,
      alias TEXT NOT NULL UNIQUE,
      path TEXT NOT NULL,
      default_branch TEXT NOT NULL DEFAULT 'main',
      github_owner TEXT,
      github_repo TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_repos_alias ON repos(alias);
  `);
}
