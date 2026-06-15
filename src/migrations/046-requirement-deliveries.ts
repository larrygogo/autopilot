import type { Database } from "bun:sqlite";

/**
 * 交付物抽象 P0 产出侧（需求中心架构 v2 R5）：`requirement_deliveries` 表。
 *
 * 每**验收轮**一行（驳回重交 = round+1，对应 PR 模型的新 commit），不做文件级行。
 * path = 相对需求运行时目录的交付落点（deliveries/round-<N>），物理文件由
 * deliverArtifacts 从任务沙盒 promote 到 runtime/requirements/<reqId>/deliveries/round-<N>/
 * —— 交付物生命周期属于需求（这件工作），不属于任务（某次执行尝试）。
 *
 * 幂等：CREATE TABLE IF NOT EXISTS。
 */
export function up(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS requirement_deliveries (
      id TEXT PRIMARY KEY,
      requirement_id TEXT NOT NULL,
      task_id TEXT,
      round INTEGER NOT NULL,
      path TEXT NOT NULL,
      summary TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(requirement_id, round)
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_requirement_deliveries_req ON requirement_deliveries(requirement_id)");
}
