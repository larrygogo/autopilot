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
  "src/core/workspaces.ts",      // workspaces 表（Phase 2 由 codebases 改名）：SQLite 即权威源，无 manifest 同步需求
  "src/core/projects.ts",        // projects 表：SQLite 即权威源（CRUD 模块），无 manifest 同步需求
  "src/core/requirements.ts",    // requirements 表：SQLite 即权威源，无 manifest 同步需求
  "src/core/requirement-feedbacks.ts", // 旧 shim：转发到 requirement-comments.ts（Phase 2 后保留兼容，无独立写）
  "src/core/requirement-questions.ts", // 旧 shim：转发到 requirement-comments.ts（Phase 2 后保留兼容）
  "src/core/requirement-comments.ts", // 统一评论表：question / feedback / handoff 合并后的 SQLite 权威源
  "src/core/requirement-attachments.ts", // requirement_attachments 表：SQLite 即权威源，附件 CRUD 无 manifest 同步需求
  "src/core/requirement-sub-prs.ts", // requirement_sub_prs 表：SQLite 即权威源，无 manifest 同步需求
  "src/core/requirement-sessions.ts", // requirement_sessions 表：SQLite 即权威源，澄清会话状态无 manifest 同步需求
  "src/core/spec-revisions.ts",  // spec_revisions 表：SQLite 即权威源，spec 修订历史无 manifest 同步需求
  "src/core/submodules.ts",      // submodules：通过 createRepo 写 repos 表，SQLite 即权威源
  "src/core/workflows.ts",       // workflows 表：SQLite 即权威源（file 工作流由 daemon 同步），无 manifest 同步需求
  "src/migrations/008-projects.ts", // P1 项目工作台改造：codebases 表重建需 INSERT 数据 copy（DDL+一次性数据迁移，无 manifest 同步需求）
  "src/migrations/009-nullable-codebase.ts", // requirements.codebase_id NOT NULL → NULLable 需表重建（DDL+一次性数据迁移）
  "src/migrations/021-requirement-comments.ts", // Phase 2 合并：把 questions+replies+feedbacks 迁移到 requirement_comments（一次性数据迁移）
  "src/migrations/023-backfill-orphan-task-requirements.ts", // 每个任务必有需求 Phase 1：回填历史游离 task 的 requirement（一次性数据迁移）
  "src/migrations/024-codebase-to-workspace.ts", // Phase 2：codebase→workspace 表/列/id 改名（DDL + UPDATE 数据迁移，无 manifest 同步需求）
  "src/migrations/027-fix-requirement-sub-prs-fk.ts", // 修悬空 FK：requirement_sub_prs 重建（DDL + INSERT...SELECT 一次性数据 copy，无 manifest 同步需求）
  "src/migrations/028-requirement-status-reason.ts", // 需求终态原因：加列 + 从 task_logs 回填历史终态需求（一次性数据迁移）
  "src/migrations/029-requirement-status-before-terminal.ts", // 死亡步定位：加列 + 从 task_logs 回填（一次性数据迁移）
  "src/migrations/033-workspace-remote-url.ts", // workspace 添加 remote_url 列 + 从本地 path 探测回填（一次性数据迁移）
  "src/migrations/037-multi-workspace-per-project.ts", // 1:N：删 1:1 索引 + 回填 requirement_workspaces（一次性数据迁移）
  "src/migrations/042-close-orphan-phase-events.ts", // 关闭终态任务遗留 open phase event（一次性数据修复，req-012 僵尸轮）
  "src/core/notifications.ts",     // notifications 表：SQLite 即权威源，事件型通知流（替代 Now 派生快照）
  "src/core/auth.ts",              // users 表：SQLite 即权威源，密码/会话状态无 manifest 同步需求
  "src/core/api-keys.ts",          // api_keys 表：SQLite 即权威源，API 密钥加密存储无 manifest 同步需求
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
