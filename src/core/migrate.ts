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

/**
 * file×ledger 一致性检查（纯函数，可测）：返回「磁盘存在、编号 ≤ currentVersion、但不在
 * applied 集合」的迁移——它们会被 `version<=current 跳过`逻辑静默略过、永不应用。
 * 判据以**磁盘实际存在的文件**为基准（不是 1..MAX 连续），故 003 这类合法空号（无文件）不误报。
 */
export function findSkippedMigrations(
  files: string[],
  currentVersion: number,
  applied: Set<number>,
): Array<{ version: number; file: string }> {
  const out: Array<{ version: number; file: string }> = [];
  for (const file of files) {
    const v = parseInt(file.slice(0, 3), 10);
    if (Number.isFinite(v) && v <= currentVersion && !applied.has(v)) {
      out.push({ version: v, file });
    }
  }
  return out;
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

  // 撞号断言：两个并行 PR 取同一迁移号时，字母序先跑的占号、另一个被 `version<=current` 静默跳过
  // 永不补跑（033 撞号曾烧伤真实 DB）。在启动期就 throw，把账本冲突挡在跑迁移之前。
  const seenVersions = new Map<number, string>();
  for (const f of files) {
    const v = parseInt(f.slice(0, 3), 10);
    const prev = seenVersions.get(v);
    if (prev) {
      throw new Error(
        `迁移号撞号：v${v} 同时存在 "${prev}" 和 "${f}"。两个迁移取了同一编号，` +
          `后者会被静默跳过永不应用。请把其中一个重排到下一个空号后再启动。`,
      );
    }
    seenVersions.set(v, f);
  }

  const currentVersion = getCurrentVersion();

  // file×ledger 一致性断言（撞号护栏只防 file×file，防不住「补一个 ≤MAX 的新号」）：
  // 磁盘存在、version ≤ currentVersion、但 schema_version 无记录的迁移 = 会被下方
  // `version<=current 跳过`逻辑静默略过、永不应用（并行分支合并取了已过号——033 烧伤同源）。
  const applied = new Set(
    getDb().query<{ version: number }, []>("SELECT version FROM schema_version").all().map((r) => r.version),
  );
  const skipped = findSkippedMigrations(files, currentVersion, applied);
  if (skipped.length > 0) {
    throw new Error(
      `迁移账本漏洞：${skipped.map((s) => s.file).join("、")} 编号 ≤ 当前已应用最高版本 v${currentVersion}，` +
        `但 schema_version 无其记录——会被「version<=current 跳过」逻辑静默略过、永不应用（多半是并行分支` +
        `合并取了已过的迁移号）。请把它重排到 > v${currentVersion} 的下一个空号后再启动。`,
    );
  }

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
      // SQLite 不允许在事务内修改 foreign_keys PRAGMA，表重建（DROP+RENAME）
      // 模式必须在 FK 关闭时执行，迁移结束后立即恢复。
      db.run("PRAGMA foreign_keys=OFF");
      try {
        db.transaction(() => {
          mod.up(db);
          db.run(
            "INSERT INTO schema_version (version, name) VALUES (?, ?)",
            [version, file.replace(/\.ts$/, "")]
          );
        })();
      } finally {
        db.run("PRAGMA foreign_keys=ON");
      }

      log.info("迁移 v%s 应用成功：%s", version, file);
      count++;
    } catch (e: unknown) {
      log.error("迁移 v%s 执行失败：%s — %s", version, file, e instanceof Error ? e.message : String(e));
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
