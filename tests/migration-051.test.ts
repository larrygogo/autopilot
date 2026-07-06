/**
 * 迁移 051 测试：workspaces.path 改为可空
 *
 * 验证：
 * 1. 执行后 workspaces.path 列可存入 NULL
 * 2. 存量数据（path 有值）完整保留
 * 3. 幂等：重复执行不报错
 * 4. 索引重建正常
 */

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { up as m051 } from "../src/migrations/051-workspace-path-nullable";

function seededDb(): Database {
  const db = new Database(":memory:");
  // 模拟 migration 008 + 024 + 033 后的 workspaces 表结构（path NOT NULL）
  db.exec(`
    CREATE TABLE workspaces (
      id                  TEXT PRIMARY KEY,
      project_id          TEXT,
      alias               TEXT NOT NULL,
      path                TEXT NOT NULL,
      remote_url          TEXT,
      default_branch      TEXT NOT NULL DEFAULT 'main',
      github_owner        TEXT,
      github_repo         TEXT,
      parent_workspace_id TEXT,
      submodule_path      TEXT,
      created_at          INTEGER NOT NULL DEFAULT 0,
      updated_at          INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.run(
    "INSERT INTO workspaces (id, project_id, alias, path, remote_url, default_branch, created_at, updated_at) " +
    "VALUES ('ws-001', 'proj-1', 'myrepo', '/home/user/myrepo', 'https://github.com/org/myrepo.git', 'main', 1, 1)",
  );
  return db;
}

function colInfo(db: Database, table: string): Array<{ name: string; notnull: number }> {
  return db
    .query<{ name: string; notnull: number }, []>(`PRAGMA table_info(${table})`)
    .all();
}

describe("migration 051 · workspaces.path nullable", () => {
  it("执行后 path 列可存入 NULL（无 NOT NULL 约束）", () => {
    const db = seededDb();
    m051(db);
    // 尝试插入 path=NULL 的记录
    expect(() => {
      db.run(
        "INSERT INTO workspaces (id, project_id, alias, path, remote_url, default_branch, created_at, updated_at) " +
        "VALUES ('ws-002', 'proj-1', 'remoterepo', NULL, 'https://github.com/org/remote.git', 'main', 2, 2)",
      );
    }).not.toThrow();
    const row = db.query<{ path: string | null }, []>("SELECT path FROM workspaces WHERE id='ws-002'").get();
    expect(row?.path).toBeNull();
  });

  it("存量数据完整保留（path 有值）", () => {
    const db = seededDb();
    m051(db);
    const row = db
      .query<{ id: string; alias: string; path: string; remote_url: string }, []>(
        "SELECT id, alias, path, remote_url FROM workspaces WHERE id='ws-001'",
      )
      .get();
    expect(row?.alias).toBe("myrepo");
    expect(row?.path).toBe("/home/user/myrepo");
    expect(row?.remote_url).toBe("https://github.com/org/myrepo.git");
  });

  it("path 列的 notnull 标志已变为 0（可空）", () => {
    const db = seededDb();
    m051(db);
    const cols = colInfo(db, "workspaces");
    const pathCol = cols.find((c) => c.name === "path");
    expect(pathCol).toBeDefined();
    expect(pathCol?.notnull).toBe(0);
  });

  it("幂等：重复执行不报错", () => {
    const db = seededDb();
    m051(db);
    expect(() => m051(db)).not.toThrow();
  });

  it("索引 idx_workspaces_project_alias 存在", () => {
    const db = seededDb();
    m051(db);
    const idx = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_workspaces_project_alias'",
      )
      .get();
    expect(idx?.name).toBe("idx_workspaces_project_alias");
  });
});
