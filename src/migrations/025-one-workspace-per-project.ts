import type { Database } from "bun:sqlite";

/**
 * 项目:工作区 1:1 约束（Phase 3）。
 *
 * 每个 project 最多 1 个顶层工作区（`parent_workspace_id IS NULL`）；submodule 不计入
 * （它们是该顶层工作区的内部组成）。
 *
 * 落法：部分唯一索引 `UNIQUE(project_id) WHERE parent_workspace_id IS NULL`。
 *
 * 冲突处理（用户拍板：中止报错让其手动整理）：建索引前先扫描，发现某 project 已挂
 * 多个顶层工作区 → throw 并列出违例，让用户手动删/拆后重跑 upgrade。不擅自改用户数据。
 *
 * 幂等：索引已存在则 CREATE UNIQUE INDEX IF NOT EXISTS 自然跳过；扫描对已满足 1:1 的
 * 库是 no-op。
 */
export function up(db: Database): void {
  // workspaces 表不存在（极早期 DB，024 之前）→ 跳过，等表建好后再跑
  const hasTable = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='workspaces'",
    )
    .get();
  if (!hasTable) return;

  // 冲突扫描：某 project 挂了 >1 个顶层工作区
  const violations = db
    .query<{ project_id: string; c: number }, []>(
      "SELECT project_id, COUNT(*) AS c FROM workspaces " +
        "WHERE parent_workspace_id IS NULL GROUP BY project_id HAVING c > 1",
    )
    .all();

  if (violations.length > 0) {
    const list = violations.map((v) => `${v.project_id}（${v.c} 个顶层工作区）`).join("，");
    throw new Error(
      "迁移 025 中止：以下项目挂了多个顶层工作区，违反「每个项目仅一个工作区」。" +
        `请手动删除/拆分后重跑 \`autopilot upgrade\`：${list}`,
    );
  }

  db.run(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_one_per_project " +
      "ON workspaces(project_id) WHERE parent_workspace_id IS NULL",
  );
}
