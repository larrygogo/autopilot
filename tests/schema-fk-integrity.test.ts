/**
 * Schema 外键完整性不变式。
 *
 * 跑完全部真实迁移后，断言数据库里不存在「悬空外键」——即外键 REFERENCES 的目标表
 * 必须真实存在。
 *
 * 动机（参考 027 修复的真实生产 bug）：
 *   migration 008/024 用 `ALTER TABLE ... RENAME TO` 给父表改名，但 Bun 内置 SQLite
 *   默认 `PRAGMA legacy_alter_table=1`，该模式下 RENAME TO **不会**改写子表 FK 的目标
 *   表名。结果 requirement_sub_prs 的 FK 长期指向已不存在的 `repos` 表，生产
 *   `foreign_keys=ON` 下删需求/删项目整条崩溃，却无任何编译期/迁移期报错。
 *
 *   普通 `PRAGMA foreign_key_check` 抓不到这种 case（空表时不报目标表缺失），所以这里
 *   显式遍历每张表的 `foreign_key_list` 校验目标表存在性，并额外跑一次
 *   `foreign_key_check` 兜住数据层 FK 违规。任何未来的 RENAME 类迁移再引入悬空 FK，
 *   都会在 CI 这一关挂掉。
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { _setDbForTest, initDb } from "../src/core/db";
import { runPendingMigrations } from "../src/core/migrate";

describe("schema 外键完整性", () => {
  let db: Database;

  beforeAll(async () => {
    db = new Database(":memory:");
    _setDbForTest(db);
    initDb();
    await runPendingMigrations();
  });

  afterAll(() => {
    _setDbForTest(null);
    db.close();
  });

  it("所有外键的目标表都真实存在（无悬空 FK）", () => {
    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all();
    const tableSet = new Set(tables.map((t) => t.name));

    const dangling: string[] = [];
    for (const t of tables) {
      // 表名来自 sqlite_master，可信；PRAGMA 不支持参数绑定，故插值。
      const fks = db
        .query<{ table: string; from: string }, []>(
          `PRAGMA foreign_key_list(${t.name})`,
        )
        .all();
      for (const fk of fks) {
        if (!tableSet.has(fk.table)) {
          dangling.push(`${t.name}.${fk.from} → ${fk.table}（目标表不存在）`);
        }
      }
    }

    if (dangling.length > 0) {
      throw new Error(
        "检测到悬空外键（目标表不存在）。多半是 RENAME TO 父表时 legacy_alter_table " +
          "未改写子表 FK，需用表重建迁移修正：\n  " + dangling.join("\n  "),
      );
    }
    expect(dangling.length).toBe(0);
  });

  it("foreign_key_check 无数据层违规", () => {
    db.run("PRAGMA foreign_keys = ON");
    const violations = db.query("PRAGMA foreign_key_check").all();
    expect(violations).toEqual([]);
  });
});
