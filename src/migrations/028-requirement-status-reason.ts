import type { Database } from "bun:sqlite";

/** requirements 表加 status_reason / status_reason_source 两列：需求进入 cancelled / failed
 *  终态时记录「为什么」（task_logs.note 短摘要或用户输入）+ 来源（user / task / system），
 *  让用户在需求页直接看到「为什么被取消/失败」，而不必下钻 task_logs 或翻 daemon.log。
 *  与 schedule_error / clarifier_error 同一可见性思路（migration 015 / 026）。
 *
 *  附 best-effort 回填：已处于终态的历史需求，从其 task 的 task_logs 取最后一条进终态的
 *  note（如「代码审查驳回 3 次，已取消」），修复 req-008 类历史事故的展示。 */
export function up(db: Database): void {
  const cols = db.query<{ name: string }, []>("PRAGMA table_info(requirements)").all();
  if (!cols.some((c) => c.name === "status_reason")) {
    db.run("ALTER TABLE requirements ADD COLUMN status_reason TEXT DEFAULT NULL");
  }
  if (!cols.some((c) => c.name === "status_reason_source")) {
    db.run("ALTER TABLE requirements ADD COLUMN status_reason_source TEXT DEFAULT NULL");
  }

  db.run(
    `UPDATE requirements SET status_reason = (
       SELECT tl.note FROM task_logs tl
       WHERE tl.task_id = requirements.task_id
         AND tl.to_status IN ('cancelled', 'failed')
         AND tl.note IS NOT NULL
       ORDER BY tl.id DESC LIMIT 1
     ), status_reason_source = 'task'
     WHERE status IN ('cancelled', 'failed')
       AND task_id IS NOT NULL
       AND status_reason IS NULL`,
  );
  // 子查询没命中 note 的行会被置回 NULL reason + 'task' source，把 source 一并清掉
  db.run("UPDATE requirements SET status_reason_source = NULL WHERE status_reason IS NULL");
}
