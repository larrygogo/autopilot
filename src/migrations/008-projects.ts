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
}
