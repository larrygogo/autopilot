import type { Database } from "bun:sqlite";

/**
 * requirements 表加 clarifier_provider + clarifier_model：
 * 单需求可 override clarifier 用哪个 provider/model；NULL = 用全局 agents.clarifier 默认。
 */
export function up(db: Database): void {
  db.run("ALTER TABLE requirements ADD COLUMN clarifier_provider TEXT DEFAULT NULL");
  db.run("ALTER TABLE requirements ADD COLUMN clarifier_model TEXT DEFAULT NULL");
}
