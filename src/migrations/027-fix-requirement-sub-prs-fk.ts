import type { Database } from "bun:sqlite";

/**
 * 修复 requirement_sub_prs.child_workspace_id 的悬空外键。
 *
 * 背景（真实生产 bug）：
 *   006 建表时 child_repo_id 的 FK 写死 `REFERENCES repos(id)`；008 把 repos
 *   `RENAME TO codebases`、024 把表名一路改到 workspaces、列名改到 child_workspace_id——
 *   但这条 FK 的**目标表名**从未被改写。024 第 22-26 行注释假设「SQLite 在父表
 *   RENAME TO 时会自动把子表 FK 引用更新为新表名」是**错误的**：Bun 内置 SQLite 默认
 *   `PRAGMA legacy_alter_table=1`，该模式下 RENAME TO 不改写子表 FK 目标。
 *
 *   结果：跑完全部迁移后，requirement_sub_prs 的 FK 实际指向已不存在的 `repos` 表。
 *   生产 db.ts 设 `foreign_keys=ON`，于是任何触及该表的 DELETE/INSERT（删需求、删项目、
 *   写子模块 PR）在 FK 解析期即抛 `no such table: main.repos`，导致删需求/删项目功能
 *   整条不可用。
 *
 * 修法：表重建，把 FK 目标改为 workspaces(id)，保留全部数据与 UNIQUE 约束。
 *   migrate.ts 跑 up() 时外层已 `PRAGMA foreign_keys=OFF` + 事务包裹，DROP+RENAME 安全。
 *
 * 幂等：若 FK 已正确指向 workspaces（或表不存在）则跳过。
 */
export function up(db: Database): void {
  // 幂等守卫：检查 child_workspace_id 的 FK 目标表。
  const fks = db
    .query<{ table: string; from: string }, []>(
      "PRAGMA foreign_key_list(requirement_sub_prs)",
    )
    .all();
  const childFk = fks.find((fk) => fk.from === "child_workspace_id");
  // 表不存在（FK 列表空）或 FK 已指向 workspaces → 无需修复
  if (!childFk || childFk.table === "workspaces") return;

  // 表重建：新表 FK 指向 workspaces，其余列定义与 UNIQUE 约束保持不变。
  db.run(`CREATE TABLE requirement_sub_prs_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    requirement_id TEXT NOT NULL REFERENCES requirements(id),
    child_workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    pr_url TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(requirement_id, child_workspace_id)
  )`);

  db.run(`INSERT INTO requirement_sub_prs_new
    (id, requirement_id, child_workspace_id, pr_url, pr_number, created_at)
    SELECT id, requirement_id, child_workspace_id, pr_url, pr_number, created_at
    FROM requirement_sub_prs`);

  db.run("DROP TABLE requirement_sub_prs");
  db.run("ALTER TABLE requirement_sub_prs_new RENAME TO requirement_sub_prs");
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_sub_prs_req ON requirement_sub_prs(requirement_id)",
  );
}
