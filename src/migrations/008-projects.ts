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
 */
export function up(db: Database): void {
  // ── 1. 新增 projects 表 ──
  db.run("CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  db.run("CREATE INDEX IF NOT EXISTS idx_projects_name ON projects(name)");
}
