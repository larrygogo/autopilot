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
  "src/core/sandbox/workspaces.ts",      // workspaces 表（Phase 2 由 codebases 改名）：SQLite 即权威源，无 manifest 同步需求
  "src/core/projects.ts",        // projects 表：SQLite 即权威源（CRUD 模块），无 manifest 同步需求
  "src/core/requirements/index.ts",    // requirements 表：SQLite 即权威源，无 manifest 同步需求
  "src/core/requirements/feedbacks.ts", // 旧 shim：转发到 requirement-comments.ts（Phase 2 后保留兼容，无独立写）
  "src/core/requirements/questions.ts", // 旧 shim：转发到 requirement-comments.ts（Phase 2 后保留兼容）
  "src/core/requirements/comments.ts", // 统一评论表：question / feedback / handoff 合并后的 SQLite 权威源
  "src/core/requirements/attachments.ts", // requirement_attachments 表：SQLite 即权威源，附件 CRUD 无 manifest 同步需求
  "src/core/requirements/sub-prs.ts", // requirement_sub_prs 表：SQLite 即权威源，无 manifest 同步需求
  "src/core/requirements/deliveries.ts", // requirement_deliveries 表：SQLite 即权威源，交付物轮次记录（v2 R5）
  "src/core/requirements/sessions.ts", // requirement_sessions 表：SQLite 即权威源，澄清会话状态无 manifest 同步需求
  "src/core/requirements/spec-revisions.ts",  // spec_revisions 表：SQLite 即权威源，spec 修订历史无 manifest 同步需求
  "src/core/sandbox/submodules.ts",      // submodules：通过 createRepo 写 repos 表，SQLite 即权威源
  "src/core/workflow/workflows.ts",       // workflows 表：SQLite 即权威源（file 工作流由 daemon 同步），无 manifest 同步需求
  "src/migrations/008-projects.ts", // P1 项目工作台改造：codebases 表重建需 INSERT 数据 copy（DDL+一次性数据迁移，无 manifest 同步需求）
  "src/migrations/009-nullable-codebase.ts", // requirements.codebase_id NOT NULL → NULLable 需表重建（DDL+一次性数据迁移）
  "src/migrations/019-task-requirement-id.ts", // 每任务必有需求 Phase 1：反向回填 tasks.requirement_id（一次性数据迁移；跨行 UPDATE...SET，整文件扫描升级后才被护栏抓到）
  "src/migrations/021-requirement-comments.ts", // Phase 2 合并：把 questions+replies+feedbacks 迁移到 requirement_comments（一次性数据迁移）
  "src/migrations/023-backfill-orphan-task-requirements.ts", // 每个任务必有需求 Phase 1：回填历史游离 task 的 requirement（一次性数据迁移）
  "src/migrations/024-codebase-to-workspace.ts", // Phase 2：codebase→workspace 表/列/id 改名（DDL + UPDATE 数据迁移，无 manifest 同步需求）
  "src/migrations/027-fix-requirement-sub-prs-fk.ts", // 修悬空 FK：requirement_sub_prs 重建（DDL + INSERT...SELECT 一次性数据 copy，无 manifest 同步需求）
  "src/migrations/028-requirement-status-reason.ts", // 需求终态原因：加列 + 从 task_logs 回填历史终态需求（一次性数据迁移）
  "src/migrations/029-requirement-status-before-terminal.ts", // 死亡步定位：加列 + 从 task_logs 回填（一次性数据迁移）
  "src/migrations/033-workspace-remote-url.ts", // workspace 添加 remote_url 列 + 从本地 path 探测回填（一次性数据迁移）
  "src/migrations/037-multi-workspace-per-project.ts", // 1:N：删 1:1 索引 + 回填 requirement_workspaces（一次性数据迁移）
  "src/migrations/042-close-orphan-phase-events.ts", // 关闭终态任务遗留 open phase event（一次性数据修复，req-012 僵尸轮）
  "src/migrations/043-workspace-id-demote-backfill.ts", // 主库语义降级：集合↔缓存列双向回填校验（一次性数据迁移，幂等）
  "src/migrations/044-task-run-columns.ts", // run 多历史：tasks 加 kind/seq + 按需求分组回填 seq（一次性数据迁移，幂等）
  "src/migrations/045-requirement-input-mode.ts", // 输入形态声明：加列 + 回填 'git'（一次性数据迁移，幂等）
  "src/core/notify/stream.ts",     // notifications 表：SQLite 即权威源，事件型通知流（替代 Now 派生快照）
  "src/core/auth.ts",              // users 表：SQLite 即权威源，密码/会话状态无 manifest 同步需求
  "src/core/api-keys.ts",          // api_keys 表：SQLite 即权威源，API 密钥加密存储无 manifest 同步需求
  "src/core/providers.ts",         // providers 表：SQLite 即权威源，provider 条目 CRUD（条目化重构 P1）
  "src/migrations/047-providers-table.ts", // provider 条目化：建表 + 种子官方三家 + 导入 config compat（一次性数据迁移，幂等）
  "src/migrations/048-workflow-kind-spec-json.ts", // workflows 加 kind/spec_json + 放开 derives_from 强制：表重建 INSERT...SELECT 数据 copy（一次性）
  "src/migrations/049-seed-native-products.ts", // 产品工作流 dev/ad-hoc：file 副本就地转 native（DELETE 旧行 + createTemplateDbWorkflow 重插，一次性，幂等）
]);

// 注：`\s` 已含换行，故整文件扫描（而非逐行）即可抓住跨行写法
//   `UPDATE foo\n  SET ...`（旧逐行版会漏判，是 single-writer 护栏的真实破口）。
// 作用域 = 行级数据写入（INSERT/UPDATE/DELETE/REPLACE）vs manifest 同步，**不含 DDL**
//   （DROP/CREATE/ALTER 是 schema 变更、归迁移，纳入只会把所有 CREATE TABLE IF NOT EXISTS
//    守卫和迁移误报成噪音，与本不变式无关）。
const WRITE_SQL_RE = /\b(INSERT\s+(OR\s+\w+\s+)?INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|REPLACE\s+INTO)\b/gi;

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
      const content = readFileSync(abs, "utf-8");
      const re = new RegExp(WRITE_SQL_RE.source, "gi");
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        // 整文件偏移 → 行号（match.index 前的换行数 + 1）
        const line = content.slice(0, m.index).split("\n").length;
        // 匹配体可能跨行（多行 UPDATE...SET），折叠空白便于阅读
        violations.push({ file: rel, line, text: m[0].replace(/\s+/g, " ") });
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
