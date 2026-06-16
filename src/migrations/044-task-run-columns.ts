import type { Database } from "bun:sqlite";

/**
 * 需求中心架构 v2 R2：run 多历史（spec 2026-06-12-requirement-centric-architecture-v2 §4）。
 *
 * tasks 表语义演进为「需求的执行历史项（run）」（表名不改，成本不对称）：
 * - `kind`：run 种类。execution=主执行（dev 的 design→submit_pr）；fix=修复轮（R3 接入）。
 * - `seq`：需求内序号（同一需求第几次执行），供排序/展示；目录定位不依赖它
 *   （文件落 runtime/requirements/<reqId>/runs/<taskId>/，不带 seq 前缀）。
 *
 * 回填 seq：按 requirement_id 分组、created_at 升序编号（同刻并列按 id 字典序裁决，
 * 保证确定性）。只给根任务编号——并行块子任务（parent_task_id 非空）是 run 的内部结构
 * 而非独立 run，保持默认 seq=1。无 requirement_id 的历史游离行也保持默认 1。
 *
 * 幂等：加列前查 PRAGMA table_info；回填 UPDATE 重算结果一致。
 */
export function up(db: Database): void {
  const cols = db
    .query<{ name: string }, []>("PRAGMA table_info(tasks)")
    .all()
    .map((c) => c.name);

  if (!cols.includes("kind")) {
    db.run("ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'execution'");
  }
  if (!cols.includes("seq")) {
    db.run("ALTER TABLE tasks ADD COLUMN seq INTEGER NOT NULL DEFAULT 1");
  }

  // requirement_id 列是 019 加的；防御缺列环境（选择性迁移的测试夹具），无列则全表默认 seq=1
  if (!cols.includes("requirement_id")) return;

  db.run(`
    UPDATE tasks SET seq = (
      SELECT COUNT(*) FROM tasks t2
      WHERE t2.requirement_id = tasks.requirement_id
        AND t2.parent_task_id IS NULL
        AND (t2.created_at < tasks.created_at
             OR (t2.created_at = tasks.created_at AND t2.id <= tasks.id))
    )
    WHERE requirement_id IS NOT NULL
      AND parent_task_id IS NULL
  `);
}
