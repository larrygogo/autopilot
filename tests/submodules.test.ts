import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { up as migrate004 } from "../src/migrations/004-repos";
import { up as migrate005 } from "../src/migrations/005-requirements";
import { up as migrate006 } from "../src/migrations/006-submodules";

describe("migration 006-submodules", () => {
  it("repos 表加 parent_repo_id + submodule_path 字段", () => {
    const db = new Database(":memory:");
    migrate004(db);
    migrate006(db);

    const cols = db.query<{ name: string }, []>("PRAGMA table_info(repos)").all();
    const names = cols.map(c => c.name).sort();
    expect(names).toContain("parent_repo_id");
    expect(names).toContain("submodule_path");
  });

  it("创建 requirement_sub_prs 表", () => {
    const db = new Database(":memory:");
    migrate004(db);
    migrate005(db);
    migrate006(db);

    const cols = db.query<{ name: string }, []>("PRAGMA table_info(requirement_sub_prs)").all();
    const names = cols.map(c => c.name).sort();
    expect(names).toEqual([
      "child_repo_id",
      "created_at",
      "id",
      "pr_number",
      "pr_url",
      "requirement_id",
    ]);
  });

  it("requirement_sub_prs UNIQUE(requirement_id, child_repo_id)", () => {
    const db = new Database(":memory:");
    migrate004(db);
    migrate005(db);
    migrate006(db);
    db.exec("PRAGMA foreign_keys = OFF;");

    db.run(
      "INSERT INTO requirement_sub_prs (requirement_id, child_repo_id, pr_url, pr_number, created_at) VALUES (?,?,?,?,?)",
      ["req-001", "repo-002", "https://github.com/x/y/pull/1", 1, 1]
    );
    expect(() => {
      db.run(
        "INSERT INTO requirement_sub_prs (requirement_id, child_repo_id, pr_url, pr_number, created_at) VALUES (?,?,?,?,?)",
        ["req-001", "repo-002", "https://github.com/x/y/pull/2", 2, 2]
      );
    }).toThrow(/UNIQUE/i);
  });
});
