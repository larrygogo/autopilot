import type { Database } from "bun:sqlite";

/**
 * 迁移 051：workspaces.path 改为可空（DROP NOT NULL）
 *
 * 背景：
 * - migration 008 建 codebases 表时 path TEXT NOT NULL（当时路径是必填）
 * - migration 033 加了 remote_url 列，应用层不再要求 path，但 SQLite 不支持 ALTER COLUMN DROP NOT NULL
 * - selfhosted-connector 自动注册 workspace 时只有 remote_url，path 传 null 触发 NOT NULL 约束失败
 *
 * 修复方案：表重建（SQLite 改约束的唯一途径），保留所有数据，仅去掉 path 的 NOT NULL。
 *
 * 幂等：已检测 path 是否仍为 NOT NULL，否则直接返回。
 * FK 说明：migrate.ts 已在事务外 PRAGMA foreign_keys=OFF，无需此处处理。
 */
export function up(db: Database): void {
  // 幂等守卫：检查 path 是否已经可空
  const colInfo = db
    .query<{ name: string; notnull: number }, []>("PRAGMA table_info(workspaces)")
    .all();
  const pathCol = colInfo.find((c) => c.name === "path");
  // notnull=0 表示已可空，直接跳过
  if (!pathCol || pathCol.notnull === 0) return;

  // 建新表（path 去掉 NOT NULL）
  db.run(`
    CREATE TABLE workspaces_new (
      id                 TEXT PRIMARY KEY,
      project_id         TEXT,
      alias              TEXT NOT NULL,
      path               TEXT,
      remote_url         TEXT,
      default_branch     TEXT NOT NULL DEFAULT 'main',
      github_owner       TEXT,
      github_repo        TEXT,
      parent_workspace_id TEXT,
      submodule_path     TEXT,
      created_at         INTEGER NOT NULL,
      updated_at         INTEGER NOT NULL
    )
  `);

  db.run(`
    INSERT INTO workspaces_new
      (id, project_id, alias, path, remote_url, default_branch, github_owner, github_repo,
       parent_workspace_id, submodule_path, created_at, updated_at)
    SELECT id, project_id, alias, path, remote_url, default_branch, github_owner, github_repo,
           parent_workspace_id, submodule_path, created_at, updated_at
    FROM workspaces
  `);

  db.run("DROP TABLE workspaces");
  db.run("ALTER TABLE workspaces_new RENAME TO workspaces");

  // 重建索引（原 024 迁移建的索引）
  db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_project_alias ON workspaces(project_id, alias)");
  db.run("CREATE INDEX IF NOT EXISTS idx_workspaces_project ON workspaces(project_id)");
}
