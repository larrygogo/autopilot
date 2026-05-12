import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { up as migrate011 } from "../src/migrations/011-now-dismissed-cards";

describe("migration 011-now-dismissed-cards", () => {
  it("创建 now_dismissed_cards 表，含 card_id 主键和 dismissed_at", () => {
    const db = new Database(":memory:");
    migrate011(db);

    const cols = db.query<{ name: string; pk: number; notnull: number }, []>(
      "PRAGMA table_info(now_dismissed_cards)"
    ).all();
    const byName = Object.fromEntries(cols.map(c => [c.name, c]));

    expect(byName["card_id"]).toBeDefined();
    expect(byName["card_id"].pk).toBe(1);
    expect(byName["card_id"].notnull).toBe(1);
    expect(byName["dismissed_at"]).toBeDefined();
    expect(byName["dismissed_at"].notnull).toBe(1);
  });

  it("插入和查询 dismissed card 可往返", () => {
    const db = new Database(":memory:");
    migrate011(db);

    db.run("INSERT INTO now_dismissed_cards (card_id, dismissed_at) VALUES (?, ?)", [
      "completed:task-5",
      1700000000000,
    ]);
    const row = db.query<{ card_id: string; dismissed_at: number }, [string]>(
      "SELECT * FROM now_dismissed_cards WHERE card_id = ?"
    ).get("completed:task-5");
    expect(row?.dismissed_at).toBe(1700000000000);
  });
});
