import type { Database } from "bun:sqlite";

/**
 * codebase → workspace 全量重命名（Phase 2）。
 *
 * 内核概念 `codebase` 收敛为 `workspace`（任务运行沙盒已于 Phase 1 改名 sandbox，
 * 故 workspace 这个名已腾空）。本迁移只改表/列/索引名 + id 前缀，**保留全部数据**，
 * 用 SQLite `ALTER TABLE ... RENAME TO` / `RENAME COLUMN`，不重建表（无 NOT NULL/约束变更需求）。
 *
 * 改名映射：
 *   表：codebases → workspaces；requirement_codebases → requirement_workspaces
 *   列：codebases.parent_codebase_id → parent_workspace_id
 *       requirement_codebases.codebase_id → workspace_id
 *       requirements.codebase_id → workspace_id
 *       requirement_sub_prs.child_codebase_id → child_workspace_id
 *   id 前缀：cb-NNN → ws-NNN（含所有引用列）
 *   索引：idx_codebases_* → idx_workspaces_*；idx_req_cb_codebase → idx_req_ws_workspace；
 *         idx_requirements_codebase(_status) → idx_requirements_workspace(_status)
 *
 * 幂等：若 codebases 表已不存在（已改名）则整体跳过。
 *
 * FK 说明（已实测确认）：
 *   - codebases 表自身无 FK（008 重建时丢掉了 parent 的 REFERENCES），id UPDATE 安全。
 *   - requirement_sub_prs.child_codebase_id FK → codebases(id)；migrate.ts 跑迁移时
 *     已 PRAGMA foreign_keys=OFF，且 SQLite 在父表 RENAME TO 时会自动把子表 FK 引用
 *     更新为新表名，RENAME COLUMN 也会更新 FK 的 from 列名，无需手工重建。
 */
export function up(db: Database): void {
  // 幂等守卫：codebases 表不存在（已改名为 workspaces）→ 跳过
  const hasCodebases = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='codebases'",
    )
    .get();
  if (!hasCodebases) return;

  // ── 1. 表改名 ──
  db.run("ALTER TABLE codebases RENAME TO workspaces");
  db.run("ALTER TABLE requirement_codebases RENAME TO requirement_workspaces");

  // ── 2. 列改名 ──
  db.run("ALTER TABLE workspaces RENAME COLUMN parent_codebase_id TO parent_workspace_id");
  db.run("ALTER TABLE requirement_workspaces RENAME COLUMN codebase_id TO workspace_id");
  db.run("ALTER TABLE requirements RENAME COLUMN codebase_id TO workspace_id");
  db.run("ALTER TABLE requirement_sub_prs RENAME COLUMN child_codebase_id TO child_workspace_id");

  // ── 3. id 前缀 cb- → ws-（含所有引用列）──
  db.run("UPDATE workspaces SET id = 'ws-' || substr(id, 4) WHERE id LIKE 'cb-%'");
  db.run(
    "UPDATE workspaces SET parent_workspace_id = 'ws-' || substr(parent_workspace_id, 4) " +
      "WHERE parent_workspace_id LIKE 'cb-%'",
  );
  db.run(
    "UPDATE requirements SET workspace_id = 'ws-' || substr(workspace_id, 4) WHERE workspace_id LIKE 'cb-%'",
  );
  db.run(
    "UPDATE requirement_workspaces SET workspace_id = 'ws-' || substr(workspace_id, 4) " +
      "WHERE workspace_id LIKE 'cb-%'",
  );
  db.run(
    "UPDATE requirement_sub_prs SET child_workspace_id = 'ws-' || substr(child_workspace_id, 4) " +
      "WHERE child_workspace_id LIKE 'cb-%'",
  );

  // ── 4. 索引改名（drop 旧建新；列名已随 RENAME COLUMN 更新）──
  db.run("DROP INDEX IF EXISTS idx_codebases_project_alias");
  db.run("DROP INDEX IF EXISTS idx_codebases_project");
  db.run("DROP INDEX IF EXISTS idx_req_cb_codebase");
  db.run("DROP INDEX IF EXISTS idx_requirements_codebase");
  db.run("DROP INDEX IF EXISTS idx_requirements_codebase_status");

  db.run(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_project_alias ON workspaces(project_id, alias)",
  );
  db.run("CREATE INDEX IF NOT EXISTS idx_workspaces_project ON workspaces(project_id)");
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_req_ws_workspace ON requirement_workspaces(workspace_id)",
  );
  db.run("CREATE INDEX IF NOT EXISTS idx_requirements_workspace ON requirements(workspace_id)");
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_requirements_workspace_status ON requirements(workspace_id, status)",
  );
}
