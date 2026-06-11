import type { Database } from "bun:sqlite";

/**
 * 需求会话表。
 * - 记录 clarifier 与 LLM 的会话状态，支持 Anthropic provider 的 session 复用
 * - agent_session_ref: Claude providerSessionId；非 Anthropic 或首轮为 NULL
 * - messages_snapshot: JSON ConversationTurn[]，供 session 失效后 replay / 审计
 */
export function up(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS requirement_sessions (
      id                TEXT PRIMARY KEY,
      requirement_id    TEXT NOT NULL,
      session_type      TEXT NOT NULL DEFAULT 'clarifying',
      agent_session_ref TEXT,
      messages_snapshot TEXT NOT NULL DEFAULT '[]',
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL,
      UNIQUE(requirement_id, session_type),
      FOREIGN KEY (requirement_id) REFERENCES requirements(id) ON DELETE CASCADE
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_req_sessions_req ON requirement_sessions(requirement_id)`);
}
