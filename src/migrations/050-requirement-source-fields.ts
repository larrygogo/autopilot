import type { Database } from "bun:sqlite";

/**
 * requirements 表加 4 个 source 追踪列（B 模式深链触发，设计见 selfhosted-autopilot-brain-design.md §4）：
 *   - source: 需求来源标识（如 'reqgenie'），可用于回传路由
 *   - external_ref: 外部系统的需求 id（如 reqgenie requirement uuid），用于回链
 *   - callback_url: autopilot 回传状态变化的 webhook URL（属于来源系统）
 *   - callback_secret: 回传 webhook 校验 secret（HMAC 签名用）
 *
 * 全部 nullable TEXT，现有需求保持 NULL，零影响存量数据。
 * 幂等：用 PRAGMA table_info 检查列存在再 ALTER（多次执行安全）。
 */
export function up(db: Database): void {
  const cols = db
    .query<{ name: string }, []>("PRAGMA table_info(requirements)")
    .all()
    .map((c) => c.name);

  if (!cols.includes("source")) {
    db.run("ALTER TABLE requirements ADD COLUMN source TEXT");
  }
  if (!cols.includes("external_ref")) {
    db.run("ALTER TABLE requirements ADD COLUMN external_ref TEXT");
  }
  if (!cols.includes("callback_url")) {
    db.run("ALTER TABLE requirements ADD COLUMN callback_url TEXT");
  }
  if (!cols.includes("callback_secret")) {
    db.run("ALTER TABLE requirements ADD COLUMN callback_secret TEXT");
  }
}
