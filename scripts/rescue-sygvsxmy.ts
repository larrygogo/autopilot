/**
 * 一次性救援脚本：把 task sygvsxmy 转 done + 修 req-003。
 *
 * 背景：
 *  - sygvsxmy 是 P3 之前用旧 setup_func 启的，task 表无 requirement_id
 *  - await_review 阶段函数硬依赖该字段，每次 spawn 立即崩，runner 没转 failed
 *  - PR #1 实际已在 2026-05-09T05:17:45Z 合并
 *
 * 操作：
 *  1. UPDATE requirements 把 req-003 关联到 sygvsxmy，status=done，pr_url/pr_number 写齐
 *  2. forceTransition(sygvsxmy, "done", note)，绕过状态机写转换日志 + emit 事件
 */
import { initDb, closeDb, getDb, getTask } from "../src/core/db";
import { forceTransition } from "../src/core/state-machine";

initDb();
const db = getDb();

const taskBefore = getTask("sygvsxmy");
if (!taskBefore) {
  console.error("task sygvsxmy 不存在");
  process.exit(1);
}
console.log("Before task.status =", taskBefore.status);

// 1) 修复 req-003：补关联 + 标 done
const nowIso = new Date().toISOString();
db.run(
  "UPDATE requirements SET status = ?, task_id = ?, pr_url = ?, pr_number = ?, updated_at = ? WHERE id = ?",
  ["done", "sygvsxmy", "https://github.com/larrygogo/aish/pull/1", 1, Date.now(), "req-003"]
);
const reqAfter = db
  .query<{ id: string; status: string; task_id: string | null; pr_url: string | null; pr_number: number | null }, []>(
    "SELECT id, status, task_id, pr_url, pr_number FROM requirements WHERE id = 'req-003'"
  )
  .get();
console.log("After req-003:", reqAfter);

// 2) task force → done
forceTransition(
  "sygvsxmy",
  "done",
  `PR #1 已合并 (2026-05-09T05:17:45Z)，手动救援收尾 @ ${nowIso}`
);

const taskAfter = getTask("sygvsxmy");
console.log("After task.status =", taskAfter?.status);

closeDb();
console.log("✓ rescue 完成");
