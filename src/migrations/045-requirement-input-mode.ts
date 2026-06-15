import type { Database } from "bun:sqlite";

/**
 * 交付物抽象 P0 输入侧（需求中心架构 v2 R5，spec 2026-06-12-deliverable-abstraction-design）：
 * `requirements.input_mode TEXT NULL` —— 需求的输入形态确认状态。
 *   - NULL   = 未确认（drafting 默认；区分「尚未确认」和「确认为无」，不能只靠 workspace_id 推导）
 *   - 'git'  = 基于代码库（setWorkspaces 非空集时写入）
 *   - 'none' = 确认无库（显式空集确认 / requires.git 非 true 的工作流放行时写入）
 *
 * 回填：已有代码库的存量需求 = 'git'（workspace_id 列是集合第一个的缓存，非空 ⟺ 集合非空）。
 * 幂等：加列前查 PRAGMA table_info；回填带 input_mode IS NULL 条件，重跑结果一致。
 */
export function up(db: Database): void {
  const cols = db
    .query<{ name: string }, []>("PRAGMA table_info(requirements)")
    .all()
    .map((c) => c.name);

  if (!cols.includes("input_mode")) {
    db.run("ALTER TABLE requirements ADD COLUMN input_mode TEXT");
  }

  db.run("UPDATE requirements SET input_mode = 'git' WHERE input_mode IS NULL AND workspace_id IS NOT NULL");
}
