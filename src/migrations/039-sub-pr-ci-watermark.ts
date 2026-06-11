import type { Database } from "bun:sqlite";

/**
 * CI 自动修复回路（pr-poller）的 per-PR 水位与护栏：
 * - ci_failed_head_sha：已处理过的失败 head commit SHA —— 同一 SHA 的 CI 失败
 *   只触发一次 fix_revision（agent 修复后 push 新 commit，新 SHA 才可再触发）
 * - ci_fix_count：CI 自动修复已触发次数；达上限（poller 内 CI_FIX_LIMIT=2）后
 *   停下报人（发通知），不再自动转 fix_revision，防环境性 CI 故障空转烧 token
 * 幂等：PRAGMA 列检查。
 */
export function up(db: Database): void {
  const hasTable = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='requirement_sub_prs'",
    )
    .get();
  if (!hasTable) return;
  const cols = db.query<{ name: string }, []>("PRAGMA table_info(requirement_sub_prs)").all();
  if (!cols.some((c) => c.name === "ci_failed_head_sha")) {
    db.run("ALTER TABLE requirement_sub_prs ADD COLUMN ci_failed_head_sha TEXT");
  }
  if (!cols.some((c) => c.name === "ci_fix_count")) {
    db.run("ALTER TABLE requirement_sub_prs ADD COLUMN ci_fix_count INTEGER NOT NULL DEFAULT 0");
  }
}
