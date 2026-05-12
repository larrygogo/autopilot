import type { Database } from "bun:sqlite";

/**
 * 项目工作台改造 P1：把现有 repos 表升级为两层结构
 *   - 新增 projects 表
 *   - repos 表 rename 为 codebases，加 project_id 外键
 *   - requirements 加 project_id，rename repo_id → codebase_id
 *   - 新增 requirement_codebases 多对多表
 *   - 新增 requirement_questions / requirement_question_replies 评论线程表
 *   - ID 前缀 repo-NNN → cb-NNN 自动转换
 *   - 旧 ready/queued 状态自动转 awaiting_approval
 *
 * 详见 docs/superpowers/specs/2026-05-08-project-workspace-redesign-design.md §5
 *
 * Task 2 仅落地 projects 表骨架；其余表/迁移由本迁移内的后续追加（Task 3+）接力。
 */
export function up(db: Database): void {
  // ── 1. 新增 projects 表 ──
  db.run(`
    CREATE TABLE IF NOT EXISTS projects (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_projects_name ON projects(name)");

  // ── 2. 新增 requirement_codebases 多对多表（一个需求可关联多个 codebase）──
  db.run(`
    CREATE TABLE IF NOT EXISTS requirement_codebases (
      requirement_id TEXT NOT NULL,
      codebase_id    TEXT NOT NULL,
      PRIMARY KEY (requirement_id, codebase_id)
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_req_cb_codebase ON requirement_codebases(codebase_id)");

  // ── 3. 新增评论线程表（requirement_questions + 多轮回复）──
  db.run(`
    CREATE TABLE IF NOT EXISTS requirement_questions (
      id             TEXT PRIMARY KEY,
      requirement_id TEXT NOT NULL,
      agent_text     TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'open',
      created_at     INTEGER NOT NULL,
      resolved_at    INTEGER
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_req_questions_req ON requirement_questions(requirement_id)");

  db.run(`
    CREATE TABLE IF NOT EXISTS requirement_question_replies (
      id          TEXT PRIMARY KEY,
      question_id TEXT NOT NULL,
      author_role TEXT NOT NULL,
      text        TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_req_qst_replies_qst ON requirement_question_replies(question_id)");

  // ── 4. repos 表 rename 为 codebases，parent_repo_id 字段同步 rename ──
  db.run("ALTER TABLE repos RENAME TO codebases");
  db.run("ALTER TABLE codebases RENAME COLUMN parent_repo_id TO parent_codebase_id");

  // ── 5. codebases 加 project_id 列 + 改 alias 唯一约束（项目内唯一）──
  // SQLite 不支持去掉列级 UNIQUE 约束（旧 alias TEXT NOT NULL UNIQUE 会残留
  // sqlite_autoindex_codebases_2）。标准做法：表重建。
  // 参考 https://sqlite.org/lang_altertable.html#otheralter
  // project_id 此时为 NULL，后续 Task 7 会反查填值。
  db.run(`
    CREATE TABLE codebases_new (
      id                 TEXT PRIMARY KEY,
      project_id         TEXT,
      alias              TEXT NOT NULL,
      path               TEXT NOT NULL,
      default_branch     TEXT NOT NULL DEFAULT 'main',
      github_owner       TEXT,
      github_repo        TEXT,
      parent_codebase_id TEXT,
      submodule_path     TEXT,
      created_at         INTEGER NOT NULL,
      updated_at         INTEGER NOT NULL
    )
  `);
  db.run(`
    INSERT INTO codebases_new
      (id, project_id, alias, path, default_branch, github_owner, github_repo,
       parent_codebase_id, submodule_path, created_at, updated_at)
    SELECT id, NULL, alias, path, default_branch, github_owner, github_repo,
           parent_codebase_id, submodule_path, created_at, updated_at
    FROM codebases
  `);
  db.run("DROP TABLE codebases");
  db.run("ALTER TABLE codebases_new RENAME TO codebases");

  db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_codebases_project_alias ON codebases(project_id, alias)");
  db.run("CREATE INDEX IF NOT EXISTS idx_codebases_project ON codebases(project_id)");

  // ── 6. 旧数据迁移：每个顶级 codebase → 建 project，填 project_id；ID 前缀 repo- → cb- ──
  // 警示：所有顶级 codebase 必须分配 project_id（避免 NULL 在 UNIQUE(project_id, alias) 下被视为 distinct
  //       而让重复 alias 滑过）。子模块继承父的 project_id，保持父+子同组。
  const oldTopRepos = db.query<{
    id: string; alias: string; created_at: number; updated_at: number
  }, []>(
    "SELECT id, alias, created_at, updated_at FROM codebases WHERE parent_codebase_id IS NULL"
  ).all();

  let projSeq = 0;
  for (const r of oldTopRepos) {
    projSeq++;
    const projId = `proj-${String(projSeq).padStart(3, "0")}`;
    db.run(
      "INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      [projId, r.alias, "从仓库自动迁移", r.created_at, r.updated_at]
    );
    // 给此 codebase 及其全部子模块填 project_id
    db.run(
      "UPDATE codebases SET project_id = ? WHERE id = ? OR parent_codebase_id = ?",
      [projId, r.id, r.id]
    );
  }

  // 转 ID 前缀 repo- → cb-（含 parent_codebase_id 自指）
  db.run("UPDATE codebases SET id = REPLACE(id, 'repo-', 'cb-') WHERE id LIKE 'repo-%'");
  db.run(
    "UPDATE codebases SET parent_codebase_id = REPLACE(parent_codebase_id, 'repo-', 'cb-') " +
    "WHERE parent_codebase_id LIKE 'repo-%'"
  );

  // ── 7. requirements 加 project_id + rename repo_id → codebase_id ──
  // SQLite ALTER TABLE 支持 RENAME COLUMN（3.25+），bun:sqlite 远超此版本。
  // ALTER ADD COLUMN 不支持 NOT NULL（除非有 DEFAULT），所以 project_id 先 NULLable 再 UPDATE 填值。
  // 旧 requirements.repo_id 是 NOT NULL 字段，RENAME COLUMN 后 codebase_id 仍然 NOT NULL，
  // 这与 spec NULLable 不一致但不影响 P1（旧数据全部有值，迁移期间无新插入），
  // 表重建去 NOT NULL 留待 P4。
  db.run("ALTER TABLE requirements RENAME COLUMN repo_id TO codebase_id");
  db.run("ALTER TABLE requirements ADD COLUMN project_id TEXT");

  // 旧索引同步迁移：005-requirements.ts 创建的 idx_requirements_repo / idx_requirements_repo_status
  // RENAME COLUMN 后仍存在但引用新字段名 codebase_id；显式 DROP 后用新名 CREATE 更整洁
  db.run("DROP INDEX IF EXISTS idx_requirements_repo");
  db.run("DROP INDEX IF EXISTS idx_requirements_repo_status");
  db.run("CREATE INDEX IF NOT EXISTS idx_requirements_codebase ON requirements(codebase_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_requirements_project ON requirements(project_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_requirements_codebase_status ON requirements(codebase_id, status)");

  // 转 codebase_id 前缀（旧 repo-NNN → cb-NNN）+ 反查从 codebases 表填 project_id
  db.run(
    "UPDATE requirements SET codebase_id = REPLACE(codebase_id, 'repo-', 'cb-') " +
    "WHERE codebase_id LIKE 'repo-%'"
  );
  db.run(
    "UPDATE requirements " +
    "SET project_id = (SELECT project_id FROM codebases WHERE codebases.id = requirements.codebase_id) " +
    "WHERE codebase_id IS NOT NULL"
  );

  // ── 8. 自动写入 requirement_codebases 多对多关联（每个有 codebase_id 的 requirement）──
  db.run(
    "INSERT INTO requirement_codebases (requirement_id, codebase_id) " +
    "SELECT id, codebase_id FROM requirements WHERE codebase_id IS NOT NULL"
  );

  // ── 9. 旧 ready/queued 状态自动转 awaiting_approval（spec §5.3：新流程没有 ready/queued） ──
  db.run(
    "UPDATE requirements SET status = 'awaiting_approval' WHERE status IN ('ready', 'queued')"
  );

  // ── 10. requirement_sub_prs.child_repo_id rename + ID 前缀转换 ──
  db.run("ALTER TABLE requirement_sub_prs RENAME COLUMN child_repo_id TO child_codebase_id");
  db.run(
    "UPDATE requirement_sub_prs SET child_codebase_id = REPLACE(child_codebase_id, 'repo-', 'cb-') " +
    "WHERE child_codebase_id LIKE 'repo-%'"
  );
}
