import type { Database } from "bun:sqlite";

/**
 * 一次性数据清理：把所有 status=clarifying 的 requirement 下的 open question 全标 resolved。
 *
 * 背景：新模型每个需求最多 1 个 active question，但历史数据可能在一个 clarifying 需求下
 * 留有多个 open question（旧 clarifier 一次扔一批的产物）。迁移后用户重新进 RequirementDetail
 * 时，前端检测到 status=clarifying && active_question_id=NULL 会调 retry-clarify 触发新一轮。
 */
export function up(db: Database): void {
  const nowMs = Date.now();
  db.run(
    "UPDATE requirement_questions " +
    "SET status='resolved', resolved_at=? " +
    "WHERE status='open' " +
    "AND requirement_id IN (SELECT id FROM requirements WHERE status='clarifying')",
    [nowMs],
  );
}
