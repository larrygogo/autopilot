import type { Database } from "bun:sqlite";

/**
 * requirements.codebase_id 改为 NULLable。
 * 原 005-requirements 建表时是 NOT NULL，008-projects 迁移仅 RENAME COLUMN，约束未变。
 * SQLite 不支持 DROP NOT NULL，需表重建。
 */
export function up(db: Database): void {
  db.run(`
    CREATE TABLE requirements_new (
      id                     TEXT PRIMARY KEY,
      project_id             TEXT,
      codebase_id            TEXT,
      title                  TEXT NOT NULL,
      status                 TEXT NOT NULL,
      spec_md                TEXT NOT NULL DEFAULT '',
      chat_session_id        TEXT,
      task_id                TEXT,
      pr_url                 TEXT,
      pr_number              INTEGER,
      last_reviewed_event_id TEXT,
      created_at             INTEGER NOT NULL,
      updated_at             INTEGER NOT NULL
    )
  `);

  db.run(`
    INSERT INTO requirements_new
      SELECT id, project_id, codebase_id, title, status, spec_md, chat_session_id,
             task_id, pr_url, pr_number, last_reviewed_event_id,
             created_at, updated_at
      FROM requirements
  `);

  db.run("DROP TABLE requirements");
  db.run("ALTER TABLE requirements_new RENAME TO requirements");

  db.run("CREATE INDEX IF NOT EXISTS idx_requirements_project ON requirements(project_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_requirements_codebase ON requirements(codebase_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_requirements_status ON requirements(status)");
  db.run("CREATE INDEX IF NOT EXISTS idx_requirements_codebase_status ON requirements(codebase_id, status)");
}
