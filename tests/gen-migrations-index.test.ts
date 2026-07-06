import { test, expect } from "bun:test";
import { readdirSync } from "fs";
import { join } from "path";
import { MIGRATIONS } from "../src/migrations/_generated-index";

test("注册表条数 = 磁盘迁移文件数", () => {
  const disk = readdirSync(join(import.meta.dir, "../src/migrations"))
    .filter((f) => /^\d{3}-[\w-]+\.ts$/.test(f));
  expect(MIGRATIONS.length).toBe(disk.length);
});

test("注册表按 version 升序且每条有 up 函数", () => {
  for (let i = 1; i < MIGRATIONS.length; i++) {
    expect(MIGRATIONS[i].version).toBeGreaterThan(MIGRATIONS[i - 1].version);
  }
  for (const m of MIGRATIONS) expect(typeof m.up).toBe("function");
});
