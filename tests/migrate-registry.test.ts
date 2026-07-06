import { test, expect } from "bun:test";
import { MIGRATIONS } from "../src/migrations/_generated-index";
import { findSkippedMigrations, latestMigrationVersion } from "../src/core/migrate";

test("latestMigrationVersion = 注册表最高号", () => {
  const max = Math.max(...MIGRATIONS.map((m) => m.version));
  expect(latestMigrationVersion()).toBe(max);
});

test("findSkippedMigrations 仍抓 file×ledger 漏洞（护栏保留）", () => {
  const files = MIGRATIONS.map((m) => m.name + ".ts");
  // 造一个「currentVersion 高于某未应用迁移」的场景
  const applied = new Set(MIGRATIONS.slice(0, -1).map((m) => m.version)); // 缺最后一条
  const cur = Math.max(...MIGRATIONS.map((m) => m.version));
  const skipped = findSkippedMigrations(files, cur, applied);
  expect(skipped.length).toBe(1); // 最后一条 ≤cur 但未 applied
});
