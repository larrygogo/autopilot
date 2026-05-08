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

describe("migration 008-projects · 表/字段 rename", () => {
  it("repos 表已 rename 为 codebases", () => {
    const db = freshDb();
    migrate008(db);

    const tables = db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('repos', 'codebases')"
    ).all().map(t => t.name);

    expect(tables).toContain("codebases");
    expect(tables).not.toContain("repos");
  });

  it("codebases 表 parent_repo_id 字段已 rename 为 parent_codebase_id", () => {
    const db = freshDb();
    migrate008(db);

    const cols = db.query<{ name: string }, []>(
      "PRAGMA table_info(codebases)"
    ).all().map(c => c.name);

    expect(cols).toContain("parent_codebase_id");
    expect(cols).not.toContain("parent_repo_id");
  });
});

describe("migration 008-projects · codebases.project_id + alias 约束", () => {
  it("codebases 表有 project_id 列", () => {
    const db = freshDb();
    migrate008(db);

    const cols = db.query<{ name: string }, []>(
      "PRAGMA table_info(codebases)"
    ).all().map(c => c.name);

    expect(cols).toContain("project_id");
  });

  it("alias 不再是全局 UNIQUE，而是 (project_id, alias) 复合 UNIQUE", () => {
    const db = freshDb();
    migrate008(db);

    const indexList = db.query<{ name: string; unique: number }, []>(
      "PRAGMA index_list(codebases)"
    ).all();
    expect(indexList.some(i => i.name === "idx_codebases_project_alias" && i.unique === 1)).toBe(true);
    // 旧的 idx_repos_alias 已被 drop
    expect(indexList.some(i => i.name === "idx_repos_alias")).toBe(false);
  });

  it("跨 project 允许相同 alias（同 project 内 alias 仍唯一）", () => {
    const db = freshDb();
    migrate008(db);

    // 模拟两个 project + 同名 codebase
    db.run("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('proj-A', 'A', 1, 1)");
    db.run("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('proj-B', 'B', 2, 2)");

    db.run("INSERT INTO codebases (id, project_id, alias, path, default_branch, created_at, updated_at) VALUES ('cb-1', 'proj-A', 'frontend', '/a', 'main', 1, 1)");

    // 不同 project 同 alias —— 必须允许
    expect(() => {
      db.run("INSERT INTO codebases (id, project_id, alias, path, default_branch, created_at, updated_at) VALUES ('cb-2', 'proj-B', 'frontend', '/b', 'main', 2, 2)");
    }).not.toThrow();

    // 同 project 同 alias —— 必须报错
    expect(() => {
      db.run("INSERT INTO codebases (id, project_id, alias, path, default_branch, created_at, updated_at) VALUES ('cb-3', 'proj-A', 'frontend', '/c', 'main', 3, 3)");
    }).toThrow();
  });
});
