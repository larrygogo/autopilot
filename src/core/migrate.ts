import { readdirSync, existsSync } from "fs";
import { join } from "path";
import { getDb } from "./db";
import { log } from "./logger";

// ──────────────────────────────────────────────
// Schema 版本管理
// ──────────────────────────────────────────────

export function ensureSchemaVersionTable(): void {
  getDb().exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
}

export function getCurrentVersion(): number {
  ensureSchemaVersionTable();
  const row = getDb()
    .query<{ version: number }, []>(
      "SELECT MAX(version) AS version FROM schema_version"
    )
    .get();
  return row?.version ?? 0;
}

// ──────────────────────────────────────────────
// 迁移执行
// ──────────────────────────────────────────────

/**
 * 扫描 src/migrations/ 目录，按 NNN-name.ts 命名格式排序，执行尚未应用的迁移。
 * 返回执行的迁移数量。
 */
export async function runPendingMigrations(): Promise<number> {
  ensureSchemaVersionTable();

  const migrationsDir = join(import.meta.dir, "../migrations");
  if (!existsSync(migrationsDir)) {
    log.warn("迁移目录不存在：%s", migrationsDir);
    return 0;
  }

  // 扫描并排序迁移文件
  const files = readdirSync(migrationsDir)
    .filter((f) => /^\d{3}-[\w-]+\.ts$/.test(f))
    .sort();

  const currentVersion = getCurrentVersion();
  let count = 0;

  for (const file of files) {
    // 从文件名提取版本号，例如 "001-baseline.ts" → 1
    const versionMatch = file.match(/^(\d{3})/);
    if (!versionMatch) continue;
    const version = parseInt(versionMatch[1], 10);

    if (version <= currentVersion) {
      log.debug("跳过已应用迁移 v%s：%s", version, file);
      continue;
    }

    const migrationPath = join(migrationsDir, file);
    log.info("执行迁移 v%s：%s", version, file);

    try {
      const mod = await import(migrationPath) as { up: (db: ReturnType<typeof getDb>) => void };
      if (typeof mod.up !== "function") {
        log.warn("迁移 %s 未导出 up() 函数，跳过", file);
        continue;
      }

      const db = getDb();
      db.transaction(() => {
        mod.up(db);
        db.run(
          "INSERT INTO schema_version (version, name) VALUES (?, ?)",
          [version, file.replace(/\.ts$/, "")]
        );
      })();

      log.info("迁移 v%s 应用成功：%s", version, file);
      count++;
    } catch (e: any) {
      log.error("迁移 v%s 执行失败：%s — %s", version, file, e.message);
      throw e;
    }
  }

  if (count === 0) {
    log.info("数据库已是最新版本（当前版本 v%s）", currentVersion);
  } else {
    log.info("共执行 %s 条迁移，当前版本 v%s", count, getCurrentVersion());
  }

  return count;
}
