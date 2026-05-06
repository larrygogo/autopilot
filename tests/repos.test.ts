import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { up as migrate004 } from "../src/migrations/004-repos";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate002 } from "../src/migrations/002-schedules";

describe("migration 004-repos", () => {
  it("创建 repos 表，包含全部约定字段", () => {
    const db = new Database(":memory:");
    migrate001(db);
    migrate002(db);
    migrate004(db);

    const cols = db.query<{ name: string; type: string; notnull: number }, []>(
      "PRAGMA table_info(repos)"
    ).all();
    const names = cols.map(c => c.name).sort();

    expect(names).toEqual([
      "alias",
      "created_at",
      "default_branch",
      "github_owner",
      "github_repo",
      "id",
      "path",
      "updated_at",
    ]);

    // alias 是 UNIQUE
    const idxList = db.query<{ name: string; unique: number }, []>(
      "PRAGMA index_list(repos)"
    ).all();
    expect(idxList.some(i => i.unique === 1)).toBe(true);
  });
});
