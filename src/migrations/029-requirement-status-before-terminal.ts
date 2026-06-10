import type { Database } from "bun:sqlite";

/** requirements 加 status_before_terminal：转 cancelled / failed 终态时记录 from 状态，
 *  让步骤条把 ✗ 画在「死亡步」而不是固定画在「完成」步。
 *  与 status_reason（migration 028）同生命周期：failed 重试时一并清空。 */
export function up(db: Database): void {
  const cols = db.query<{ name: string }, []>("PRAGMA table_info(requirements)").all();
  if (!cols.some((c) => c.name === "status_before_terminal")) {
    db.run("ALTER TABLE requirements ADD COLUMN status_before_terminal TEXT DEFAULT NULL");
  }
  // best-effort 回填：有 task 的终态需求，从 task_logs 最后一条进终态行的 from_status 推断需求级位置
  db.run(
    `UPDATE requirements SET status_before_terminal = (
       SELECT CASE
         WHEN tl.from_status LIKE '%fix_revision%' THEN 'fix_revision'
         WHEN tl.from_status LIKE '%await_review%' THEN 'awaiting_review'
         ELSE 'running'
       END
       FROM task_logs tl
       WHERE tl.task_id = requirements.task_id
         AND (tl.to_status IN ('cancelled', 'failed') OR tl.to_status LIKE 'failed_%')
       ORDER BY tl.id DESC LIMIT 1
     )
     WHERE status IN ('cancelled', 'failed')
       AND task_id IS NOT NULL
       AND status_before_terminal IS NULL`,
  );
  // task_id 为 NULL 的终态需求（执行前被取消）无从推断，留 NULL，UI 兜底
}
