import type { Database } from "bun:sqlite";

/**
 * 需求附件表。
 * - category: 'image' | 'text' | 'pdf' | 'office'
 * - file_path: 磁盘绝对路径（~/.autopilot/attachments/<req-id>/<filename>）
 * - extracted_text: PDF/office/text 内容；图片为 NULL（Agent 用 Read 工具直接读）
 */
export function up(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS requirement_attachments (
      id            TEXT    PRIMARY KEY,
      requirement_id TEXT   NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
      original_name TEXT    NOT NULL,
      mime_type      TEXT    NOT NULL,
      file_path      TEXT    NOT NULL,
      file_size      INTEGER NOT NULL,
      category       TEXT    NOT NULL CHECK(category IN ('image','text','pdf','office')),
      extracted_text TEXT,
      created_at     INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_req_attachments_req
      ON requirement_attachments(requirement_id, created_at)
  `);
}
