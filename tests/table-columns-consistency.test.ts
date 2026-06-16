/**
 * TABLE_COLUMNS 一致性不变式：
 *   db.ts 的手维护 `TABLE_COLUMNS` Set 必须与 tasks 表的真实列（schema + 全部迁移后）严格相等。
 *
 * 动机（architect 2026-06-15 审查 H1）：
 *   TABLE_COLUMNS 是 updateTask / state-machine 用来区分「真实列 vs extra JSON」的影子 schema。
 *   一旦某迁移给 tasks 加了列却忘了同步这个 Set，updateTask 会把该列的更新**静默塞进 extra JSON**、
 *   真实列保持旧值——无任何报错的写错位。此测试让这种漂移在 CI 暴露。
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { _setDbForTest, initDb, getDb, TABLE_COLUMNS } from "../src/core/db";
import { runPendingMigrations } from "../src/core/migrate";

describe("TABLE_COLUMNS 一致性", () => {
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

  it("TABLE_COLUMNS 与 tasks 表真实列严格相等", () => {
    const rows = getDb()
      .query<{ name: string }, []>("PRAGMA table_info(tasks)")
      .all();
    const actual = new Set(rows.map((r) => r.name));

    // 真实列里有、但 Set 漏了 → 加列忘同步 Set，updateTask 会把它误判成 extra（最危险）
    const missingFromSet = [...actual].filter((c) => !TABLE_COLUMNS.has(c));
    // Set 里有、但真实列没有 → 删列/改名忘清 Set（次要，但同样是漂移）
    const staleInSet = [...TABLE_COLUMNS].filter((c) => !actual.has(c));

    expect({ missingFromSet, staleInSet }).toEqual({ missingFromSet: [], staleInSet: [] });
  });
});
