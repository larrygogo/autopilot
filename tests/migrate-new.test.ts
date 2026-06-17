import { describe, expect, test } from "bun:test";
import { nextMigrationVersion, normalizeMigrationSlug } from "../src/core/migrate";

describe("nextMigrationVersion（自动取号 = MAX+1）", () => {
  test("空目录 → 1", () => {
    expect(nextMigrationVersion([])).toBe(1);
  });

  test("取现有最大号 +1（非连续也按最大算）", () => {
    expect(nextMigrationVersion(["001-baseline.ts", "002-x.ts", "047-providers-table.ts"])).toBe(48);
  });

  test("忽略不规范文件名", () => {
    expect(nextMigrationVersion(["001-a.ts", "garbage.ts", "9-bad.ts", "010-b.ts"])).toBe(11);
  });
});

describe("normalizeMigrationSlug", () => {
  test("空格 / 下划线 → 连字符，转小写", () => {
    expect(normalizeMigrationSlug("Add User Table")).toBe("add-user-table");
    expect(normalizeMigrationSlug("foo_bar_baz")).toBe("foo-bar-baz");
  });

  test("剔除非法字符 + 折叠多余连字符", () => {
    expect(normalizeMigrationSlug("foo!!  --bar")).toBe("foo-bar");
  });

  test("规范化后为空 → 抛错", () => {
    expect(() => normalizeMigrationSlug("!!!")).toThrow();
    expect(() => normalizeMigrationSlug("   ")).toThrow();
  });
});
