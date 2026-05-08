import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate002 } from "../src/migrations/002-schedules";
import { up as migrate004 } from "../src/migrations/004-repos";
import { up as migrate005 } from "../src/migrations/005-requirements";
import { up as migrate006 } from "../src/migrations/006-submodules";
import { up as migrate007 } from "../src/migrations/007-workflows";
import { up as migrate008 } from "../src/migrations/008-projects";

function freshDb(): Database {
  const db = new Database(":memory:");
  migrate001(db);
  migrate002(db);
  migrate004(db);
  migrate005(db);
  migrate006(db);
  migrate007(db);
  return db;
}

describe("migration 008-projects · projects 表", () => {
  it("创建 projects 表，含约定字段", () => {
    const db = freshDb();
    migrate008(db);

    const cols = db.query<{ name: string }, []>(
      "PRAGMA table_info(projects)"
    ).all();
    const names = cols.map(c => c.name).sort();
    expect(names).toEqual([
      "created_at", "description", "id", "name", "updated_at"
    ]);
  });

  it("projects.name 有索引", () => {
    const db = freshDb();
    migrate008(db);

    const idx = db.query<{ name: string }, []>(
      "PRAGMA index_list(projects)"
    ).all();
    expect(idx.some(i => i.name === "idx_projects_name")).toBe(true);
  });
});
