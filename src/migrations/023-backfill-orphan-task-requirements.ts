/**
 * Migration 023 — 回填历史游离任务的需求（每个任务必有需求 Phase 1）。
 *
 * 背景：Phase 1 在应用层强制 task 必须挂在一条 requirement 下，但历史 DB 里
 * 存在 requirement_id 为空的游离 task（早期路径 / 并行子任务 / CLI 手建）。
 * Phase 2 要给 requirement_id 加 NOT NULL + FK，加约束前必须先把这些游离 task
 * 回填到某条 requirement，否则约束变更会炸。
 *
 * 策略（纯 INSERT/UPDATE，幂等，只处理 requirement_id IS NULL，不动列约束、不 DROP 表）：
 *   1. 确保兜底项目 proj-default 存在。
 *   2. 子 task（parent_task_id 非空 + requirement_id 为空）：继承父 task 的 requirement_id。
 *   3. 顶层游离 task（parent_task_id 为空 + requirement_id 为空）：各建一条 requirement
 *      （title=task.title，spec_md 从 task.extra.requirement 取、没有则用 title，
 *      project_id=反查 codebase.project_id 或 proj-default），requirement.status 与
 *      task 终态对齐（done/failed/cancelled→对应，否则 running），双向回填
 *      task.requirement_id + requirement.task_id。
 *
 * 幂等：重跑只看 requirement_id IS NULL 的 task，已回填的不再处理；不重复建 requirement。
 */

import type { Database } from "bun:sqlite";

const DEFAULT_PROJECT_ID = "proj-default";

interface TaskRow {
  id: string;
  title: string;
  status: string;
  extra: string | null;
  parent_task_id: string | null;
}

/** task 终态 → requirement 状态映射；非终态一律 running。 */
function reqStatusForTask(taskStatus: string): string {
  if (taskStatus === "done" || taskStatus === "failed" || taskStatus === "cancelled") {
    return taskStatus;
  }
  return "running";
}

/** 从 task.extra JSON 取 requirement 文本，失败/缺失返回空串。 */
function extractRequirementText(extra: string | null): string {
  if (!extra) return "";
  try {
    const obj = JSON.parse(extra) as Record<string, unknown>;
    const req = obj["requirement"];
    return typeof req === "string" ? req : "";
  } catch {
    return "";
  }
}

export async function up(db: Database): Promise<void> {
  // requirements 表不存在则无从回填（极早期 DB）；直接跳过。
  const reqTable = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='requirements'",
    )
    .get();
  if (!reqTable) return;

  const now = Date.now();

  // 1. 确保兜底项目存在（projects 表一定存在于 008 之后）
  const projTable = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='projects'",
    )
    .get();
  if (projTable) {
    const existing = db
      .query<{ id: string }, [string]>("SELECT id FROM projects WHERE id = ?")
      .get(DEFAULT_PROJECT_ID);
    if (!existing) {
      db.run(
        "INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        [DEFAULT_PROJECT_ID, "默认 / Default", "快捷发包 / 定时任务（无显式项目）的兜底项目", now, now],
      );
    }
  }

  // 2. 子 task 继承父 requirement_id（可能多层，循环到不再有变化）
  for (let i = 0; i < 50; i++) {
    const changed = db.run(
      `UPDATE tasks
         SET requirement_id = (
           SELECT p.requirement_id FROM tasks p WHERE p.id = tasks.parent_task_id
         )
       WHERE requirement_id IS NULL
         AND parent_task_id IS NOT NULL
         AND (SELECT p.requirement_id FROM tasks p WHERE p.id = tasks.parent_task_id) IS NOT NULL`,
    );
    if (changed.changes === 0) break;
  }

  // 3. 顶层游离 task：各建一条 requirement + 双向回填
  const orphans = db
    .query<TaskRow, []>(
      "SELECT id, title, status, extra, parent_task_id FROM tasks " +
        "WHERE requirement_id IS NULL AND parent_task_id IS NULL",
    )
    .all();

  if (orphans.length === 0) {
    // 仍可能残留「父也游离」的子 task（父不在顶层但父也无需求）——保险：把剩余游离子 task 也当顶层处理
    backfillRemainingChildren(db, now);
    return;
  }

  // 计算下一个 req-NNN 起始编号（扫 requirements + requirement_comments，避免删后复用）
  let nextNum = computeNextReqNum(db);

  const hasCodebaseCol = db
    .query<{ name: string }, []>("PRAGMA table_info(tasks)")
    .all()
    .some((c) => c.name === "codebase_id");
  const hasReqCodebasesTable = !!db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='requirement_codebases'",
    )
    .get();

  for (const task of orphans) {
    const reqId = `req-${String(nextNum).padStart(3, "0")}`;
    nextNum++;

    // 反查 codebase / project：task 上可能有 codebase_id 列（迁移 009 之后）
    let codebaseId: string | null = null;
    if (hasCodebaseCol) {
      const row = db
        .query<{ codebase_id: string | null }, [string]>("SELECT codebase_id FROM tasks WHERE id = ?")
        .get(task.id);
      codebaseId = row?.codebase_id ?? null;
    }
    let projectId = DEFAULT_PROJECT_ID;
    if (codebaseId) {
      const cb = db
        .query<{ project_id: string }, [string]>("SELECT project_id FROM codebases WHERE id = ?")
        .get(codebaseId);
      if (cb) projectId = cb.project_id;
      else codebaseId = null; // codebase 已删，降级到兜底项目
    }

    const title = task.title || task.id;
    const specMd = extractRequirementText(task.extra) || title;
    const status = reqStatusForTask(task.status);

    db.run(
      "INSERT INTO requirements (id, project_id, codebase_id, title, status, spec_md, task_id, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [reqId, projectId, codebaseId, title.slice(0, 200), status, specMd, task.id, now, now],
    );
    if (codebaseId && hasReqCodebasesTable) {
      db.run(
        "INSERT OR IGNORE INTO requirement_codebases (requirement_id, codebase_id) VALUES (?, ?)",
        [reqId, codebaseId],
      );
    }
    db.run("UPDATE tasks SET requirement_id = ? WHERE id = ?", [reqId, task.id]);
  }

  // 顶层回填后，子 task 可能仍游离（父刚拿到需求）→ 再继承一轮
  for (let i = 0; i < 50; i++) {
    const changed = db.run(
      `UPDATE tasks
         SET requirement_id = (
           SELECT p.requirement_id FROM tasks p WHERE p.id = tasks.parent_task_id
         )
       WHERE requirement_id IS NULL
         AND parent_task_id IS NOT NULL
         AND (SELECT p.requirement_id FROM tasks p WHERE p.id = tasks.parent_task_id) IS NOT NULL`,
    );
    if (changed.changes === 0) break;
  }

  backfillRemainingChildren(db, now);
}

/**
 * 兜底：父也游离（父无需求且父不是顶层）的子 task。正常数据不会到这，
 * 但为保 Phase 2 加约束前彻底无残留，把它们各建一条 requirement 直接挂上。
 */
function backfillRemainingChildren(db: Database, now: number): void {
  const remaining = db
    .query<TaskRow, []>(
      "SELECT id, title, status, extra, parent_task_id FROM tasks WHERE requirement_id IS NULL",
    )
    .all();
  if (remaining.length === 0) return;

  let nextNum = computeNextReqNum(db);
  for (const task of remaining) {
    const reqId = `req-${String(nextNum).padStart(3, "0")}`;
    nextNum++;
    const title = task.title || task.id;
    const specMd = extractRequirementText(task.extra) || title;
    const status = reqStatusForTask(task.status);
    db.run(
      "INSERT INTO requirements (id, project_id, codebase_id, title, status, spec_md, task_id, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [reqId, DEFAULT_PROJECT_ID, null, title.slice(0, 200), status, specMd, task.id, now, now],
    );
    db.run("UPDATE tasks SET requirement_id = ? WHERE id = ?", [reqId, task.id]);
  }
}

function computeNextReqNum(db: Database): number {
  const hasCommentsTable = !!db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='requirement_comments'",
    )
    .get();
  const sql = hasCommentsTable
    ? "SELECT id FROM requirements WHERE id LIKE 'req-%' " +
      "UNION SELECT requirement_id AS id FROM requirement_comments WHERE requirement_id LIKE 'req-%' " +
      "ORDER BY id DESC LIMIT 1"
    : "SELECT id FROM requirements WHERE id LIKE 'req-%' ORDER BY id DESC LIMIT 1";
  const rows = db.query<{ id: string }, []>(sql).all();
  if (rows.length === 0) return 1;
  return parseInt(rows[0].id.replace("req-", ""), 10) + 1;
}
