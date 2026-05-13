import type { Database } from "bun:sqlite";

/**
 * requirements 表加 active_question_id 字段。
 * - 标识"当前等用户回答的那个 question"。
 * - clarifier 决定下一题时 set；用户答完时清空或指向下一题；进 awaiting_approval 时为 NULL。
 * - /now 的 open-question CardSource 据此每需求出 1 卡。
 *
 * 不在 SQL 层加 FK ON DELETE SET NULL：bun:sqlite 对 ALTER TABLE 添加 FK 列支持有限；
 * 业务层（deleteRequirement / resolveQuestion）维护引用一致性。
 */
export function up(db: Database): void {
  db.run("ALTER TABLE requirements ADD COLUMN active_question_id TEXT DEFAULT NULL");
}
