import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate002 } from "../src/migrations/002-schedules";
import { up as migrate004 } from "../src/migrations/004-repos";
import { up as migrate005 } from "../src/migrations/005-requirements";
import { up as migrate006 } from "../src/migrations/006-submodules";
import { up as migrate007 } from "../src/migrations/007-workflows";
import { up as migrate008 } from "../src/migrations/008-projects";
import { up as migrate009 } from "../src/migrations/009-nullable-codebase";
import { up as migrate024 } from "../src/migrations/024-codebase-to-workspace";
import { up as migrate025 } from "../src/migrations/025-one-workspace-per-project";

/** 跑到 024（workspaces 表 + ws- 前缀就位）的空库。 */
function dbThrough024(): Database {
  const db = new Database(":memory:");
  for (const m of [migrate001, migrate002, migrate004, migrate005, migrate006, migrate007, migrate008, migrate009, migrate024]) {
    m(db);
  }
  db.run("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('proj-001', 'p', 1, 1)");
  db.run("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('proj-002', 'q', 1, 1)");
  return db;
}

function addTop(db: Database, id: string, project: string): void {
  db.run(
    "INSERT INTO workspaces (id, project_id, alias, path, default_branch, created_at, updated_at) VALUES (?, ?, ?, '/p', 'main', 1, 1)",
    [id, project, id],
  );
}
function addSub(db: Database, id: string, project: string, parent: string): void {
  db.run(
    "INSERT INTO workspaces (id, project_id, alias, path, default_branch, parent_workspace_id, submodule_path, created_at, updated_at) VALUES (?, ?, ?, '/p/s', 'main', ?, 's', 2, 2)",
    [id, project, id, parent],
  );
}

describe("migration 025 — 项目:工作区 1:1", () => {
  it("无冲突时建部分唯一索引，且后续插入第二个顶层工作区会被拒", () => {
    const db = dbThrough024();
    addTop(db, "ws-001", "proj-001");
    migrate025(db);

    // 索引已建
    const idx = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_workspaces_one_per_project'")
      .get();
    expect(idx).toBeTruthy();

    // 同 project 再插一个顶层 → UNIQUE 冲突
    expect(() => addTop(db, "ws-002", "proj-001")).toThrow();
  });

  it("submodule 不计入：1 顶层 + N 子模块照常通过", () => {
    const db = dbThrough024();
    addTop(db, "ws-001", "proj-001");
    addSub(db, "ws-002", "proj-001", "ws-001");
    addSub(db, "ws-003", "proj-001", "ws-001");
    expect(() => migrate025(db)).not.toThrow();
    // 索引建好后，submodule 仍可继续加（parent 非空不受唯一约束）
    expect(() => addSub(db, "ws-004", "proj-001", "ws-001")).not.toThrow();
  });

  it("存在违例（某 project 多个顶层）时中止报错并列出违例", () => {
    const db = dbThrough024();
    addTop(db, "ws-001", "proj-001");
    addTop(db, "ws-002", "proj-001"); // proj-001 两个顶层 → 违例
    addTop(db, "ws-003", "proj-002");
    expect(() => migrate025(db)).toThrow(/proj-001/);
  });

  it("不同 project 各一个顶层 → 通过", () => {
    const db = dbThrough024();
    addTop(db, "ws-001", "proj-001");
    addTop(db, "ws-002", "proj-002");
    expect(() => migrate025(db)).not.toThrow();
  });

  it("幂等：重复跑不炸", () => {
    const db = dbThrough024();
    addTop(db, "ws-001", "proj-001");
    migrate025(db);
    expect(() => migrate025(db)).not.toThrow();
  });
});
