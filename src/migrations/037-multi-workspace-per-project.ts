import type { Database } from "bun:sqlite";

/**
 * 项目:代码库 1:1 → 1:N。
 * 1. 删 025 的部分唯一索引（不改 025 文件本身）。
 * 2. 回填 requirement_workspaces：历史 updateRequirement 改 workspace_id 不同步关联表，
 *    且 1:N 后该表成为「需求代码库集合」的真相，必须先补齐「主库 ∈ 集合」不变式。
 * 幂等：DROP IF EXISTS + INSERT OR IGNORE。
 */
export function up(db: Database): void {
  const hasTable = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='workspaces'",
    )
    .get();
  if (!hasTable) return;
  db.run("DROP INDEX IF EXISTS idx_workspaces_one_per_project");
  db.run(
    "INSERT OR IGNORE INTO requirement_workspaces (requirement_id, workspace_id) " +
      "SELECT id, workspace_id FROM requirements WHERE workspace_id IS NOT NULL",
  );
}
