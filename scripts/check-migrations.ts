#!/usr/bin/env bun
// ──────────────────────────────────────────────
// 迁移撞号 / 命名 lint —— CI 在 PR 阶段拦截，不必等部署后 daemon 启动时 throw。
//
// 两个并行 PR 各取同一迁移号都能过 `bun test` 绿灯合并，合并到 main 后 daemon/upgrade
// 启动才炸（033 撞号烧伤过真实 DB）。这个纯文件扫描把撞号挡在合并前，零依赖、无需 DB。
// 与 src/core/migrate.ts 的 seenVersions 撞号护栏同源逻辑。
// ──────────────────────────────────────────────
import { readdirSync, existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const dir = join(import.meta.dir, "../src/migrations");
if (!existsSync(dir)) {
  console.error(`✗ 找不到迁移目录：${dir}`);
  process.exit(1);
}

// 排除 codegen 生成的注册表文件（下划线前缀），只扫描真正的迁移文件
const all = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.startsWith("_"));
const valid = all.filter((f) => /^\d{3}-[\w-]+\.ts$/.test(f)).sort();
let bad = false;

// ① 命名规范：所有 .ts 都得是 NNN-slug.ts
for (const f of all) {
  if (!/^\d{3}-[\w-]+\.ts$/.test(f)) {
    console.error(`✗ 迁移命名不规范：${f}（应为 NNN-slug.ts）`);
    bad = true;
  }
}

// ② 撞号：同一编号出现两次
const seen = new Map<number, string>();
for (const f of valid) {
  const v = parseInt(f.slice(0, 3), 10);
  const prev = seen.get(v);
  if (prev) {
    console.error(`✗ 迁移撞号 v${v}：「${prev}」与「${f}」取了同一编号——后者会被静默跳过永不应用。`);
    console.error(`  修复：把其中一个改名到下一个空号（autopilot migrate new <slug> 会自动取号）。`);
    bad = true;
  } else {
    seen.set(v, f);
  }
}

if (bad) {
  console.error("迁移检查未通过。");
  process.exit(1);
}

// ③ 生成物与磁盘一致性：重跑 codegen 后 git 无 diff
execSync("bun run scripts/gen-migrations-index.ts", { stdio: "ignore" });
const diff = execSync("git status --porcelain src/migrations/_generated-index.ts", { encoding: "utf-8" }).trim();
if (diff) {
  console.error("✗ src/migrations/_generated-index.ts 与磁盘迁移文件不一致。请跑 `bun run gen:migrations` 并提交。");
  process.exit(1);
}

console.log(`✓ ${valid.length} 条迁移：编号无撞号、命名规范、注册表与磁盘一致。`);
