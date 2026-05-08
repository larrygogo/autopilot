import type { Database } from "bun:sqlite";

export function up(db: Database): void {
  db.run("ALTER TABLE requirement_questions ADD COLUMN suggestions TEXT NOT NULL DEFAULT '[]'");
}
