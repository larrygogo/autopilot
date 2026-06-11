import type { Database } from "bun:sqlite";

/**
 * 旧「Now 决策收件箱」体系 teardown：dismiss 持久化表随派生快照模型一并移除。
 * 通知系统（notifications 表，035）的 dismissed_at 列承接同语义。
 * 与 035 分两个迁移号：035 上线时旧 aggregator 还在读此表（双轨期）。
 */
export function up(db: Database): void {
  db.run("DROP TABLE IF EXISTS now_dismissed_cards");
}
