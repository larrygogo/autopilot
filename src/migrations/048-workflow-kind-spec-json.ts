import type { Database } from "bun:sqlite";

/**
 * workflows 表加 `kind` + `spec_json`，并放开 007 的「source=db 必须 derives_from」CHECK，
 * 为「独立 DB 工作流」(kind=native：DB 是真相源、无寄生 base) 铺路（方案 C / Step 2）。
 *
 * - kind: file(磁盘镜像) | derived(寄生 base，= 007 的 source=db) | native(独立 DB) | template(框架种子)
 * - spec_json: kind=native/template 的「结构原生 json」真相；file/derived 为 NULL（真相仍是 yaml_content / 磁盘）
 *
 * SQLite 不能 ALTER DROP CHECK → 表重建。迁移系统已在事务外切 PRAGMA foreign_keys=OFF（CLAUDE.md），
 * 故 DROP+RENAME 安全；其它表对 workflows 的引用按 name（renamed 后仍解析），无硬 FK。
 */
export function up(db: Database): void {
  db.run(`
    CREATE TABLE workflows_new (
      name           TEXT PRIMARY KEY,
      description    TEXT NOT NULL DEFAULT '',
      yaml_content   TEXT NOT NULL,
      spec_json      TEXT,
      source         TEXT NOT NULL CHECK(source IN ('db', 'file')),
      kind           TEXT NOT NULL DEFAULT 'derived' CHECK(kind IN ('file', 'derived', 'native', 'template')),
      derives_from   TEXT,
      file_path      TEXT,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL,
      CHECK(
        (kind = 'file'                  AND source = 'file' AND file_path IS NOT NULL AND derives_from IS NULL) OR
        (kind = 'derived'               AND source = 'db'   AND derives_from IS NOT NULL AND file_path IS NULL) OR
        (kind IN ('native', 'template') AND source = 'db'   AND derives_from IS NULL    AND file_path IS NULL AND spec_json IS NOT NULL)
      )
    )
  `);
  // 回填：file 行→kind='file'；存量 db 行都是寄生派生→kind='derived'。spec_json 暂空（native 才用）。
  db.run(`
    INSERT INTO workflows_new (name, description, yaml_content, spec_json, source, kind, derives_from, file_path, created_at, updated_at)
    SELECT name, description, yaml_content, NULL, source,
           CASE source WHEN 'file' THEN 'file' ELSE 'derived' END,
           derives_from, file_path, created_at, updated_at
    FROM workflows
  `);
  db.run("DROP TABLE workflows");
  db.run("ALTER TABLE workflows_new RENAME TO workflows");
  db.run("CREATE INDEX IF NOT EXISTS idx_workflows_source ON workflows(source)");
  db.run("CREATE INDEX IF NOT EXISTS idx_workflows_kind ON workflows(kind)");
}
