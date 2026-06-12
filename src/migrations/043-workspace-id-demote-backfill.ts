import type { Database } from "bun:sqlite";

/**
 * 需求「主库」语义降级（2026-06-12 spec：废除主/副库之分，方案 b）。
 *
 * 自此 requirements.workspace_id 列保留、继续写，但语义从「主库（任务执行库）」
 * 降级为「冗余缓存 = 集合（requirement_workspaces）第一个」；一切主库语义读方
 * 改走 requirement_workspaces 集合表。不删列（表重建不可逆，024 教训）、不停写
 * （遗漏读方拿到的仍是集合内合法库，最坏退化为旧行为而非崩溃）。
 *
 * 本迁移是纯数据校验回填（无 DDL、幂等）：
 * 1. 集合为空但列非空 → 补一行集合（防御历史脏数据，与 037 同口径）
 * 2. 列 NULL 但集合非空 → 回填列 = 集合内 created_at 最早的 workspace
 *    （requirement_workspaces 关联表本身无 created_at 列，故按 workspace 自身的
 *     created_at 取最早 —— 与 listRequirementWorkspaces 的排序口径一致）
 */
export function up(db: Database): void {
  const hasTables = (name: string): boolean =>
    !!db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
      )
      .get(name);
  if (!hasTables("requirement_workspaces") || !hasTables("workspaces")) return;

  // 1. 集合为空但列非空 → 防御性补集合行（INSERT OR IGNORE 幂等）
  db.run(
    "INSERT OR IGNORE INTO requirement_workspaces (requirement_id, workspace_id) " +
      "SELECT id, workspace_id FROM requirements WHERE workspace_id IS NOT NULL",
  );

  // 2. 列 NULL 但集合非空 → 回填缓存列（JOIN workspaces 过滤悬空关联，按 created_at 最早）
  db.run(`
    UPDATE requirements SET workspace_id = (
      SELECT rw.workspace_id FROM requirement_workspaces rw
      JOIN workspaces w ON w.id = rw.workspace_id
      WHERE rw.requirement_id = requirements.id
      ORDER BY w.created_at ASC LIMIT 1
    )
    WHERE workspace_id IS NULL
      AND EXISTS (
        SELECT 1 FROM requirement_workspaces rw2
        JOIN workspaces w2 ON w2.id = rw2.workspace_id
        WHERE rw2.requirement_id = requirements.id
      )
  `);
}
