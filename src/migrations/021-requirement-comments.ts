import type { Database } from "bun:sqlite";

/**
 * Phase 2 — 合并 requirement_questions + requirement_question_replies + requirement_feedbacks
 * 为统一的 requirement_comments 表。
 *
 * 字段：
 *   id TEXT PK              复用旧 qst-NNN（question 不改），feedback 加 fb- 前缀（旧 INTEGER 转字符串）
 *   requirement_id          FK requirements.id
 *   parent_id               单层树，question 顶层 = null，reply 指向 question.id
 *   kind                    question / feedback / handoff
 *   from_role               agent / user / github
 *   body                    文本
 *   suggestions             JSON 数组（仅 question 用）
 *   status                  open / resolved（feedback / reply 默认 resolved）
 *   github_review_id        仅 from_role=github
 *   created_at / resolved_at
 *
 * 详见 docs/specs/2026-05-20-paseo-mindshare-integration.md §3.2 + §4.1
 *
 * 数据迁移规则：
 *   - questions → kind=question, from_role=agent, id 保持原 qst-NNN
 *   - question_replies → kind=question, parent_id=question.id, id 保持原 qst-rNNN
 *   - feedbacks → kind=feedback, id 加 fb- 前缀（避免与 qst- 冲突）
 *   - 旧三表 DROP（不留兼容视图，spec §6.1 清算性整改）
 */
export function up(db: Database): void {
  // ── 1. 新表 ──
  db.run(`
    CREATE TABLE IF NOT EXISTS requirement_comments (
      id TEXT PRIMARY KEY,
      requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
      parent_id TEXT REFERENCES requirement_comments(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      from_role TEXT NOT NULL,
      body TEXT NOT NULL,
      suggestions TEXT,
      status TEXT NOT NULL,
      github_review_id TEXT,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER
    );
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_requirement_comments_req_time ON requirement_comments(requirement_id, created_at);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_requirement_comments_parent ON requirement_comments(parent_id);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_requirement_comments_status ON requirement_comments(status);`);

  // ── 2. questions → comments ──
  // suggestions 列由 m010 添加。如果测试跳过 m010 但跑了 m021，列可能不存在，回退到 NULL。
  const questionCols = db.query<{ name: string }, []>("PRAGMA table_info(requirement_questions)").all().map(c => c.name);
  const hasSuggestions = questionCols.includes("suggestions");
  db.run(`
    INSERT INTO requirement_comments
      (id, requirement_id, parent_id, kind, from_role, body, suggestions, status, created_at, resolved_at)
    SELECT id, requirement_id, NULL, 'question', 'agent', agent_text,
           ${hasSuggestions ? "suggestions" : "NULL"}, status, created_at, resolved_at
    FROM requirement_questions
  `);

  // ── 3. question_replies → comments（parent_id 指向原 question.id） ──
  db.run(`
    INSERT INTO requirement_comments
      (id, requirement_id, parent_id, kind, from_role, body, suggestions, status, created_at, resolved_at)
    SELECT r.id,
           (SELECT q.requirement_id FROM requirement_questions q WHERE q.id = r.question_id),
           r.question_id,
           'question',
           r.author_role,
           r.text,
           NULL,
           'resolved',
           r.created_at,
           r.created_at
    FROM requirement_question_replies r
  `);

  // ── 4. feedbacks → comments（id 加 fb- 前缀） ──
  db.run(`
    INSERT INTO requirement_comments
      (id, requirement_id, parent_id, kind, from_role, body, suggestions, status, github_review_id, created_at, resolved_at)
    SELECT 'fb-' || id,
           requirement_id,
           NULL,
           'feedback',
           CASE source WHEN 'github_review' THEN 'github' ELSE 'user' END,
           body,
           NULL,
           'resolved',
           github_review_id,
           created_at,
           created_at
    FROM requirement_feedbacks
  `);

  // ── 5. 删旧表 ──
  db.run("DROP TABLE requirement_question_replies");
  db.run("DROP TABLE requirement_questions");
  db.run("DROP TABLE requirement_feedbacks");
}
