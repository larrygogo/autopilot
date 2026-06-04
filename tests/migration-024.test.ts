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

/**
 * 跑到 009（codebases 完整结构就位）的库，并塞一组样例数据：
 *   - 1 顶层 codebase + 1 子模块（parent_codebase_id 自指）
 *   - 1 requirement 引用顶层 codebase
 *   - 1 requirement_codebases 关联
 *   - 1 requirement_sub_prs 引用子模块
 */
function seededDb(): Database {
  const db = new Database(":memory:");
  migrate001(db);
  migrate002(db);
  migrate004(db);
  migrate005(db);
  migrate006(db);
  migrate007(db);
  migrate008(db);
  migrate009(db);

  db.run("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('proj-001', 'p', 1, 1)");
  db.run(
    "INSERT INTO codebases (id, project_id, alias, path, default_branch, created_at, updated_at) VALUES ('cb-001', 'proj-001', 'parent', '/p', 'main', 1, 1)",
  );
  db.run(
    "INSERT INTO codebases (id, project_id, alias, path, default_branch, parent_codebase_id, submodule_path, created_at, updated_at) VALUES ('cb-002', 'proj-001', 'sub', '/p/s', 'main', 'cb-001', 's', 2, 2)",
  );
  db.run(
    "INSERT INTO requirements (id, project_id, codebase_id, title, status, created_at, updated_at) VALUES ('req-001', 'proj-001', 'cb-001', 't', 'draft', 3, 3)",
  );
  db.run(
    "INSERT INTO requirement_codebases (requirement_id, codebase_id) VALUES ('req-001', 'cb-001')",
  );
  db.run(
    "INSERT INTO requirement_sub_prs (requirement_id, child_codebase_id, pr_url, pr_number, created_at) VALUES ('req-001', 'cb-002', 'http://x', 7, 4)",
  );
  return db;
}

function tableNames(db: Database): string[] {
  return db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((t) => t.name);
}

function cols(db: Database, table: string): string[] {
  return db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);
}

describe("migration 024 · 表/列改名", () => {
  it("codebases → workspaces；requirement_codebases → requirement_workspaces", () => {
    const db = seededDb();
    migrate024(db);
    const tables = tableNames(db);
    expect(tables).toContain("workspaces");
    expect(tables).toContain("requirement_workspaces");
    expect(tables).not.toContain("codebases");
    expect(tables).not.toContain("requirement_codebases");
  });

  it("列改名：parent_workspace_id / workspace_id / child_workspace_id", () => {
    const db = seededDb();
    migrate024(db);

    expect(cols(db, "workspaces")).toContain("parent_workspace_id");
    expect(cols(db, "workspaces")).not.toContain("parent_codebase_id");

    expect(cols(db, "requirement_workspaces")).toContain("workspace_id");
    expect(cols(db, "requirement_workspaces")).not.toContain("codebase_id");

    expect(cols(db, "requirements")).toContain("workspace_id");
    expect(cols(db, "requirements")).not.toContain("codebase_id");

    expect(cols(db, "requirement_sub_prs")).toContain("child_workspace_id");
    expect(cols(db, "requirement_sub_prs")).not.toContain("child_codebase_id");
  });
});

describe("migration 024 · id 前缀 cb- → ws-", () => {
  it("workspaces.id 及 parent_workspace_id 自指已转 ws-", () => {
    const db = seededDb();
    migrate024(db);
    const rows = db
      .query<{ id: string; parent_workspace_id: string | null }, []>(
        "SELECT id, parent_workspace_id FROM workspaces ORDER BY id",
      )
      .all();
    expect(rows.map((r) => r.id)).toEqual(["ws-001", "ws-002"]);
    const sub = rows.find((r) => r.id === "ws-002");
    expect(sub?.parent_workspace_id).toBe("ws-001");
  });

  it("引用列同步转 ws-，引用一致", () => {
    const db = seededDb();
    migrate024(db);

    const req = db
      .query<{ workspace_id: string }, []>("SELECT workspace_id FROM requirements WHERE id='req-001'")
      .get();
    expect(req?.workspace_id).toBe("ws-001");

    const link = db
      .query<{ workspace_id: string }, []>(
        "SELECT workspace_id FROM requirement_workspaces WHERE requirement_id='req-001'",
      )
      .get();
    expect(link?.workspace_id).toBe("ws-001");

    const subPr = db
      .query<{ child_workspace_id: string }, []>(
        "SELECT child_workspace_id FROM requirement_sub_prs WHERE requirement_id='req-001'",
      )
      .get();
    expect(subPr?.child_workspace_id).toBe("ws-002");

    // 引用一致性：req.workspace_id 能 join 到 workspaces
    const joined = db
      .query<{ alias: string }, []>(
        "SELECT w.alias FROM requirements r JOIN workspaces w ON w.id = r.workspace_id WHERE r.id='req-001'",
      )
      .get();
    expect(joined?.alias).toBe("parent");
  });
});

describe("migration 024 · 索引改名", () => {
  it("旧索引消失，新索引就位", () => {
    const db = seededDb();
    migrate024(db);
    const idx = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'",
      )
      .all()
      .map((i) => i.name);

    expect(idx).toContain("idx_workspaces_project_alias");
    expect(idx).toContain("idx_workspaces_project");
    expect(idx).toContain("idx_req_ws_workspace");
    expect(idx).toContain("idx_requirements_workspace");
    expect(idx).toContain("idx_requirements_workspace_status");

    expect(idx).not.toContain("idx_codebases_project_alias");
    expect(idx).not.toContain("idx_codebases_project");
    expect(idx).not.toContain("idx_req_cb_codebase");
    expect(idx).not.toContain("idx_requirements_codebase");
    expect(idx).not.toContain("idx_requirements_codebase_status");
  });

  it("idx_workspaces_project_alias 仍是 UNIQUE（同 project 内 alias 唯一）", () => {
    const db = seededDb();
    migrate024(db);
    expect(() => {
      db.run(
        "INSERT INTO workspaces (id, project_id, alias, path, default_branch, created_at, updated_at) VALUES ('ws-099', 'proj-001', 'parent', '/dup', 'main', 9, 9)",
      );
    }).toThrow();
  });
});

describe("migration 024 · 幂等", () => {
  it("重复跑不炸，且数据不变", () => {
    const db = seededDb();
    migrate024(db);
    expect(() => migrate024(db)).not.toThrow();

    const tables = tableNames(db);
    expect(tables).toContain("workspaces");
    expect(tables).not.toContain("codebases");

    const ids = db
      .query<{ id: string }, []>("SELECT id FROM workspaces ORDER BY id")
      .all()
      .map((r) => r.id);
    expect(ids).toEqual(["ws-001", "ws-002"]);
  });
});
