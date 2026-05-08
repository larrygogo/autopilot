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

describe("migration 008-projects · requirement_codebases 多对多表", () => {
  it("创建 requirement_codebases 表，PK 是 (req_id, codebase_id) 组合", () => {
    const db = freshDb();
    migrate008(db);

    const cols = db.query<{ name: string; pk: number }, []>(
      "PRAGMA table_info(requirement_codebases)"
    ).all();
    const pkCols = cols.filter(c => c.pk > 0).map(c => c.name).sort();
    expect(pkCols).toEqual(["codebase_id", "requirement_id"]);
  });

  it("有 idx_req_cb_codebase 索引", () => {
    const db = freshDb();
    migrate008(db);

    const idx = db.query<{ name: string }, []>(
      "PRAGMA index_list(requirement_codebases)"
    ).all();
    expect(idx.some(i => i.name === "idx_req_cb_codebase")).toBe(true);
  });
});

describe("migration 008-projects · 评论线程表", () => {
  it("创建 requirement_questions 表，含 status 默认 open", () => {
    const db = freshDb();
    migrate008(db);

    const cols = db.query<{ name: string; dflt_value: string | null }, []>(
      "PRAGMA table_info(requirement_questions)"
    ).all();
    const names = cols.map(c => c.name).sort();
    expect(names).toEqual([
      "agent_text", "created_at", "id", "requirement_id", "resolved_at", "status"
    ]);

    const status = cols.find(c => c.name === "status");
    expect(status?.dflt_value).toContain("open");
  });

  it("创建 requirement_question_replies 表", () => {
    const db = freshDb();
    migrate008(db);

    const cols = db.query<{ name: string }, []>(
      "PRAGMA table_info(requirement_question_replies)"
    ).all();
    const names = cols.map(c => c.name).sort();
    expect(names).toEqual([
      "author_role", "created_at", "id", "question_id", "text"
    ]);
  });
});
