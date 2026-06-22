import { readdirSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { getDb } from "./db";
import { log } from "./logger";

export const MIGRATIONS_DIR = join(import.meta.dir, "../migrations");
const MIGRATION_FILE_RE = /^\d{3}-[\w-]+\.ts$/;

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
// 迁移脚手架（`autopilot migrate new <slug>`）——自动取号，从源头防撞号
// ──────────────────────────────────────────────

/** 从迁移文件名列表算下一个可用编号 = MAX(现有号)+1。空目录 → 1。 */
export function nextMigrationVersion(files: string[]): number {
  let max = 0;
  for (const f of files) {
    const m = f.match(/^(\d{3})-[\w-]+\.ts$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

/** 磁盘上最高的迁移文件编号（= 该跑到的目标版本）。无迁移目录 / 空 → 0。doctor 据此判有无未应用迁移。 */
export function latestMigrationVersion(): number {
  if (!existsSync(MIGRATIONS_DIR)) return 0;
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => MIGRATION_FILE_RE.test(f));
  return nextMigrationVersion(files) - 1;
}

/** slug 规范化：小写、空格/下划线→连字符、剔除非法字符；必须以字母数字开头。 */
export function normalizeMigrationSlug(raw: string): string {
  const slug = raw.trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error(`非法迁移名 "${raw}"：规范化后为空或不合法，只能用小写字母 / 数字 / 连字符。`);
  }
  return slug;
}

function migrationTemplate(slug: string): string {
  return `import type { Database } from "bun:sqlite";

/**
 * TODO: 描述这条迁移做什么。
 *
 * 幂等：用 IF NOT EXISTS / 防御性写法，保证重复跑安全。
 * 涉及 DROP TABLE / 表重建时 migrate.ts 已自动在事务外切 PRAGMA foreign_keys=OFF，无需在此处理。
 */
export function up(db: Database): void {
  // TODO: 实现迁移，例如 db.run(\`CREATE TABLE IF NOT EXISTS ${slug.replace(/-/g, "_")} (...)\`);
  void db;
}
`;
}

/**
 * 在 MIGRATIONS_DIR 生成下一个编号的迁移骨架文件。编号 = 现有最大号 +1（自动取号，
 * 把「挑号」从人工挪到工具，避免单分支内手挑撞号；跨分支撞号由 CI lint 在合并前拦截）。
 */
export function scaffoldMigration(rawSlug: string): { path: string; file: string; version: number } {
  const slug = normalizeMigrationSlug(rawSlug);
  const files = existsSync(MIGRATIONS_DIR)
    ? readdirSync(MIGRATIONS_DIR).filter((f) => MIGRATION_FILE_RE.test(f))
    : [];
  const version = nextMigrationVersion(files);
  const file = `${String(version).padStart(3, "0")}-${slug}.ts`;
  const path = join(MIGRATIONS_DIR, file);
  if (existsSync(path)) throw new Error(`迁移文件已存在：${file}`);
  writeFileSync(path, migrationTemplate(slug), "utf-8");
  return { path, file, version };
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

  const migrationsDir = MIGRATIONS_DIR;
  if (!existsSync(migrationsDir)) {
    log.warn("迁移目录不存在：%s", migrationsDir);
    return 0;
  }

  // 扫描并排序迁移文件
  const files = readdirSync(migrationsDir)
    .filter((f) => MIGRATION_FILE_RE.test(f))
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
      // up 可选返回一个「事务后副作用」闭包：用于不可逆且非事务性的清理（如删磁盘文件）。
      // 放事务外执行，保证「DB 改动回滚 → 副作用绝不发生」，杜绝 DB↔磁盘不一致（049 的教训）。
      const mod = await import(migrationPath) as {
        up: (db: ReturnType<typeof getDb>) => unknown;
      };
      if (typeof mod.up !== "function") {
        log.warn("迁移 %s 未导出 up() 函数，跳过", file);
        continue;
      }

      const db = getDb();
      // SQLite 不允许在事务内修改 foreign_keys PRAGMA，表重建（DROP+RENAME）
      // 模式必须在 FK 关闭时执行，迁移结束后立即恢复。
      db.run("PRAGMA foreign_keys=OFF");
      let afterCommit: (() => void) | undefined = undefined;
      try {
        db.transaction(() => {
          const result = mod.up(db);
          if (typeof result === "function") afterCommit = result as () => void;
          db.run(
            "INSERT INTO schema_version (version, name) VALUES (?, ?)",
            [version, file.replace(/\.ts$/, "")]
          );
        })();
      } finally {
        db.run("PRAGMA foreign_keys=ON");
      }

      // 事务已 commit（回滚会在 transaction() 内 throw、根本到不了这里）：执行事务后副作用。
      // 失败只 warn——DB 改动已生效、不该因清理失败回退；幂等迁移下次启动可重试。
      if (afterCommit) {
        const runAfter = afterCommit as () => void; // 闭包捕获的 let 不被 TS narrow，显式断言
        try {
          runAfter();
        } catch (e: unknown) {
          log.warn(
            "迁移 v%s 事务后副作用执行失败（DB 改动已生效，不影响迁移成功）：%s",
            version,
            e instanceof Error ? e.message : String(e),
          );
        }
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
