import { getDb } from "./db";

/**
 * 子模块 PR 记录。表列在迁移 024 后统一为 child_workspace_id（早期经历
 * child_repo_id → child_codebase_id → child_workspace_id 两轮改名），TS 接口
 * 字段与列名一致。
 */
export interface RequirementSubPr {
  id: number;
  requirement_id: string;
  child_workspace_id: string;
  pr_url: string;
  pr_number: number;
  created_at: number;
}

export interface AppendSubPrOpts {
  requirement_id: string;
  child_workspace_id: string;
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
    `INSERT INTO requirement_sub_prs (requirement_id, child_workspace_id, pr_url, pr_number, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(requirement_id, child_workspace_id) DO UPDATE SET
       pr_url = excluded.pr_url,
       pr_number = excluded.pr_number`,
    [opts.requirement_id, opts.child_workspace_id, opts.pr_url, opts.pr_number, ts]
  );
  return db
    .query<RequirementSubPr, [string, string]>(
      "SELECT id, requirement_id, child_workspace_id, pr_url, pr_number, created_at " +
      "FROM requirement_sub_prs WHERE requirement_id = ? AND child_workspace_id = ?"
    )
    .get(opts.requirement_id, opts.child_workspace_id) as RequirementSubPr;
}

/**
 * 列出某需求的所有子模块 PR（按 created_at 升序）。
 */
export function listSubPrs(requirementId: string): RequirementSubPr[] {
  const db = getDb();
  return db
    .query<RequirementSubPr, [string]>(
      "SELECT id, requirement_id, child_workspace_id, pr_url, pr_number, created_at " +
      "FROM requirement_sub_prs WHERE requirement_id = ? ORDER BY created_at ASC, id ASC"
    )
    .all(requirementId);
}

/**
 * 清空某需求的全部子模块 PR 记录（重跑专用，RERUN-08）。
 * 重跑=全新一轮：上一轮的子模块 PR（appendSubPr UPSERT 写入）须清，否则需求页残留本轮未触及
 * 子模块的过期 PR 链接。区别于 deleteRequirement 的级联删除——这里保留需求、仅清 sub_prs。
 */
export function clearSubPrs(requirementId: string): void {
  getDb().run("DELETE FROM requirement_sub_prs WHERE requirement_id = ?", [requirementId]);
}
