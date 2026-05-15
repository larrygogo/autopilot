/**
 * Migration 019 — tasks 表加 requirement_id 字段 + 反向回填。
 *
 * 背景：之前 task → requirement 是单向（requirements.task_id 字段），
 * 从 task 反查需求需要 SELECT requirements WHERE task_id = ?，每条都查
 * 一次性能差，UI 上的「任务来自哪个需求」也展示不便。
 *
 * 改动：
 *   1. tasks 表加 requirement_id TEXT 列（可空，兼容历史无关联任务）
 *   2. 加索引 idx_tasks_requirement_id 用于反查
 *   3. 回填：扫 requirements 表，根据 requirements.task_id 把 requirement.id
 *      写到对应 tasks.requirement_id
 *   4. 未来 task-factory 创建 task 时同时写 requirement_id 字段（双向关联）
 *
 * 幂等：列已存在则跳过添加；回填只更新当前 NULL 的行，已写过的不动。
 */

import type { Database } from "bun:sqlite";

export async function up(db: Database): Promise<void> {
  // 1. 添加列（兼容已存在）
  const cols = db.query<{ name: string }, []>("PRAGMA table_info(tasks)").all();
  const hasCol = cols.some((c) => c.name === "requirement_id");
  if (!hasCol) {
    db.run("ALTER TABLE tasks ADD COLUMN requirement_id TEXT DEFAULT NULL");
  }

  // 2. 加索引（IF NOT EXISTS 幂等）
  db.run("CREATE INDEX IF NOT EXISTS idx_tasks_requirement_id ON tasks (requirement_id)");

  // 3. 反向回填（仅当 requirements 表存在）
  const reqTable = db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='requirements'",
  ).get();
  if (!reqTable) return;

  // 找出 requirements.task_id 不为空的关联，写回 tasks.requirement_id（仅 NULL 时写，避免覆盖）
  db.run(
    `UPDATE tasks
     SET requirement_id = (
       SELECT r.id FROM requirements r WHERE r.task_id = tasks.id LIMIT 1
     )
     WHERE requirement_id IS NULL
       AND id IN (SELECT task_id FROM requirements WHERE task_id IS NOT NULL)`,
  );
}
