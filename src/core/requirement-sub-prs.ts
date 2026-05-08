import { getDb } from "./db";

/**
 * 008 迁移后表列改名 child_repo_id → child_codebase_id；TS 接口字段保持 child_repo_id 兼容旧调用方，
 * SQL 用列别名 `child_codebase_id AS child_repo_id` 让 SELECT * 仍然映射到旧字段名。
 * P2/P3 重构 chat tools/调度器后可统一改为 child_codebase_id。
 */
export interface RequirementSubPr {
  id: number;
  requirement_id: string;
  child_repo_id: string;
  pr_url: string;
  pr_number: number;
  created_at: number;
}

export interface AppendSubPrOpts {
  requirement_id: string;
  child_repo_id: string;
  pr_url: string;
  pr_number: number;
}

/**
 * 追加一条子模块 PR 记录。已存在（UNIQUE 冲突）时更新 pr_url/pr_number。
 */
export function appendSubPr(opts: AppendSubPrOpts): RequirementSubPr {
  const db = getDb();
  const ts = Date.now();
  db.run(
    `INSERT INTO requirement_sub_prs (requirement_id, child_codebase_id, pr_url, pr_number, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(requirement_id, child_codebase_id) DO UPDATE SET
       pr_url = excluded.pr_url,
       pr_number = excluded.pr_number`,
    [opts.requirement_id, opts.child_repo_id, opts.pr_url, opts.pr_number, ts]
  );
  return db
    .query<RequirementSubPr, [string, string]>(
      "SELECT id, requirement_id, child_codebase_id AS child_repo_id, pr_url, pr_number, created_at " +
      "FROM requirement_sub_prs WHERE requirement_id = ? AND child_codebase_id = ?"
    )
    .get(opts.requirement_id, opts.child_repo_id) as RequirementSubPr;
}

/**
 * 列出某需求的所有子模块 PR（按 created_at 升序）。
 */
export function listSubPrs(requirementId: string): RequirementSubPr[] {
  const db = getDb();
  return db
    .query<RequirementSubPr, [string]>(
      "SELECT id, requirement_id, child_codebase_id AS child_repo_id, pr_url, pr_number, created_at " +
      "FROM requirement_sub_prs WHERE requirement_id = ? ORDER BY created_at ASC, id ASC"
    )
    .all(requirementId);
}
