import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { up as m033 } from "../src/migrations/033-workspace-remote-url";

/**
 * 构造一个包含 workspaces 表的内存库。
 * 只建最小 schema 供 033 迁移跑通（不拉全链迁移，避免依赖过多）。
 */
function seededDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL DEFAULT '',
      alias TEXT NOT NULL DEFAULT '',
      path TEXT NOT NULL DEFAULT '',
      default_branch TEXT NOT NULL DEFAULT 'main',
      github_owner TEXT,
      github_repo TEXT,
      parent_workspace_id TEXT,
      submodule_path TEXT,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    )
  `);
  // 插入一条 path 无效的旧 workspace（模拟探测失败 → 软失效）
  db.run(
    "INSERT INTO workspaces (id, project_id, alias, path, default_branch, created_at, updated_at) " +
    "VALUES ('ws-001', '', 'myrepo', '/nonexistent/path', 'main', 1, 1)",
  );
  return db;
}

function cols(db: Database, table: string): string[] {
  return db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);
}

describe("migration 033 · remote_url 列", () => {
  it("执行后 workspaces 表含 remote_url 列", () => {
    const db = seededDb();
    m033(db);
    expect(cols(db, "workspaces")).toContain("remote_url");
  });

  it("path 不存在时 remote_url 仍为 NULL（软失效）", () => {
    const db = seededDb();
    m033(db);
    const row = db
      .query<{ remote_url: string | null }, []>("SELECT remote_url FROM workspaces WHERE id='ws-001'")
      .get();
    expect(row?.remote_url).toBeNull();
  });

  it("幂等：重复执行不报错", () => {
    const db = seededDb();
    m033(db);
    expect(() => m033(db)).not.toThrow();
  });

  it("已有 remote_url 的 workspace 不被覆盖", () => {
    const db = seededDb();
    // 先跑一次让列存在
    m033(db);
    // 插入一条已有 remote_url 的 workspace
    db.run(
      "INSERT INTO workspaces (id, project_id, alias, path, remote_url, default_branch, created_at, updated_at) " +
      "VALUES ('ws-002', '', 'repo2', '', 'https://github.com/owner/repo.git', 'main', 2, 2)",
    );
    // 再跑一次
    m033(db);
    const row = db
      .query<{ remote_url: string | null }, []>("SELECT remote_url FROM workspaces WHERE id='ws-002'")
      .get();
    expect(row?.remote_url).toBe("https://github.com/owner/repo.git");
  });
});
