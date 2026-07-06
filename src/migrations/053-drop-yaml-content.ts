import type { Database } from "bun:sqlite";
import { parse as parseYaml } from "yaml";
import { createLogger } from "../core/logger";

const log = createLogger("migration-053");

/**
 * P2：删除 workflows 表的 yaml_content 列（spec_json 成为唯一真相）。
 *
 * 步骤：
 *   ① derived 行回填 spec_json（parse yaml_content → JSON.stringify 写 spec_json）。
 *      解析失败的行：log.warn 保留原样，spec_json 保持 NULL——discover 跳过并告警，不丢数据。
 *   ② 表重建删 yaml_content 列（照 048 手法：CREATE new → INSERT...SELECT → DROP → RENAME）。
 *      migrate.ts 已在事务外 PRAGMA foreign_keys=OFF，无需迁移文件内处理。
 *
 * schema 自适应：insertSpecDbWorkflow 已做 PRAGMA table_info 自适应——053 跑完后
 * yaml_content 列不再存在，后续 INSERT 不包含该列。
 *
 * fs 无副作用（返回空 afterCommit 闭包）。
 *
 * 单次写迁移（一次性表重建 + derived 回填）——加进 single-writer-invariant.test.ts 白名单。
 */
export function up(db: Database): { afterCommit?: () => void } {
  // 检查 yaml_content 列是否仍存在（幂等：若已重跑过则 no-op）
  const cols = db
    .query<{ name: string }, []>("PRAGMA table_info(workflows)")
    .all()
    .map((r) => r.name);
  if (!cols.includes("yaml_content")) {
    // 列已不在——迁移已跑过，no-op
    return {};
  }

  // ① derived 行回填：yaml_content → spec_json
  const derivedRows = db
    .query<{ name: string; yaml_content: string; spec_json: string | null }, []>(
      "SELECT name, yaml_content, spec_json FROM workflows WHERE kind = 'derived'"
    )
    .all();

  for (const row of derivedRows) {
    if (row.spec_json && row.spec_json.trim()) {
      // spec_json 已有内容，跳过（不覆盖）
      continue;
    }
    try {
      const parsed = parseYaml(row.yaml_content) as Record<string, unknown> | null;
      if (!parsed || typeof parsed !== "object") {
        log.warn("derived 工作流 %s yaml 解析为非对象，跳过回填 spec_json", row.name);
        continue;
      }
      const specJson = JSON.stringify(parsed);
      db.run("UPDATE workflows SET spec_json = ? WHERE name = ? AND kind = 'derived'", [specJson, row.name]);
    } catch (e: unknown) {
      log.warn(
        "derived 工作流 %s yaml 解析失败，保留行原样（spec_json 仍 NULL）：%s",
        row.name,
        e instanceof Error ? e.message : String(e)
      );
    }
  }

  // ② 表重建删 yaml_content 列
  db.run(`
    CREATE TABLE workflows_new (
      name           TEXT PRIMARY KEY,
      description    TEXT NOT NULL DEFAULT '',
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

  db.run(`
    INSERT INTO workflows_new (name, description, spec_json, source, kind, derives_from, file_path, created_at, updated_at)
    SELECT name, description, spec_json, source, kind, derives_from, file_path, created_at, updated_at
    FROM workflows
  `);

  db.run("DROP TABLE workflows");
  db.run("ALTER TABLE workflows_new RENAME TO workflows");
  db.run("CREATE INDEX IF NOT EXISTS idx_workflows_source ON workflows(source)");
  db.run("CREATE INDEX IF NOT EXISTS idx_workflows_kind ON workflows(kind)");

  return {};
}
