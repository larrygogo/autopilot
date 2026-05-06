import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

/**
 * Single-writer 不变式（参考 gsd）：
 *   所有写 SQL（INSERT / UPDATE / DELETE / REPLACE ...）只允许出现在白名单
 *   文件中。新增写点必须加到白名单；否则 CI 挂掉提醒你。
 *
 * 动机：
 *   task-manifest.json 是权威源，SQLite 是索引。任何直接写 DB 而绕过 manifest
 *   同步的路径都会让两者失同步。把写入集中在少数文件里，便于审计与加 hook。
 */
const ALLOWLIST = new Set([
  "src/core/db.ts",              // 主入口：createTask / updateTask / createSubTask
  "src/core/state-machine.ts",   // transition / forceTransition
  "src/core/migrate.ts",         // 迁移：INSERT schema_version
  "src/core/rebuild-index.ts",   // 索引重建：从 manifest INSERT/UPDATE 回 DB
  "src/core/schedules.ts",       // schedules 表：SQLite 即权威源，无 manifest 同步需求
  "src/core/repos.ts",           // repos 表：SQLite 即权威源，无 manifest 同步需求
]);

const WRITE_SQL_RE = /\b(INSERT\s+(OR\s+\w+\s+)?INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|REPLACE\s+INTO)\b/i;

function listTsFilesIn(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) {
      out.push(...listTsFilesIn(full));
    } else if (info.isFile() && entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("single-writer invariant", () => {
  it("write SQL 只在白名单内出现", () => {
    const repoRoot = join(import.meta.dir, "..");
    const srcDir = join(repoRoot, "src");
    const files = listTsFilesIn(srcDir);

    const violations: { file: string; line: number; text: string }[] = [];
    for (const abs of files) {
      const rel = abs.slice(repoRoot.length + 1).replace(/\\/g, "/");
      if (ALLOWLIST.has(rel)) continue;
      const lines = readFileSync(abs, "utf-8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (WRITE_SQL_RE.test(line)) {
          violations.push({ file: rel, line: i + 1, text: line.trim() });
        }
      }
    }

    if (violations.length > 0) {
      const msg = violations.map((v) => `  ${v.file}:${v.line}  ${v.text}`).join("\n");
      throw new Error(
        "检测到白名单外的写 SQL，请将写入集中到 db.ts / state-machine.ts / migrate.ts / rebuild-index.ts：\n" + msg
      );
    }
    expect(violations.length).toBe(0);
  });
});
