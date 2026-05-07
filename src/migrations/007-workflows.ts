import type { Database } from "bun:sqlite";

/**
 * 007-workflows
 *
 * 创建 workflows 表，作为工作流配置的权威存储。
 *
 * - source='file': 文件工作流（~/.autopilot/workflows/<name>/）的 DB 镜像；
 *   yaml_content 由 daemon 启动时同步；file_path 指向原目录绝对路径。
 * - source='db':   chat / CLI 创建的派生工作流；必须 derives_from 一个
 *   source='file' 工作流；phase 函数从 base 复用；不允许嵌套派生（W1 限制）。
 *
 * CHECK 约束保证两种 source 的字段组合合法（参见 spec §3.1）。
 */
export function up(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS workflows (
      name           TEXT PRIMARY KEY,
      description    TEXT NOT NULL DEFAULT '',
      yaml_content   TEXT NOT NULL,
      source         TEXT NOT NULL CHECK(source IN ('db', 'file')),
      derives_from   TEXT,
      file_path      TEXT,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL,
      CHECK(
        (source = 'db'   AND derives_from IS NOT NULL AND file_path IS NULL) OR
        (source = 'file' AND derives_from IS NULL     AND file_path IS NOT NULL)
      )
    )
  `);
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_workflows_source ON workflows(source)"
  );
}
