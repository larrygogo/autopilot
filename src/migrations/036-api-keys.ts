/**
 * API 密钥存储表。AES-256-GCM 加密存储，脱敏展示。
 */
import type { Database } from "bun:sqlite";

export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id          TEXT PRIMARY KEY,
      provider    TEXT NOT NULL UNIQUE,
      key_enc     TEXT NOT NULL,
      key_hint    TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}
