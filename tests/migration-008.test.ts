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

describe("migration 008-projects · 旧数据迁移", () => {
  it("每个旧顶级 repo 自动建一个 project 并把 id 填到 codebase.project_id", () => {
    // 准备旧 schema 数据 — 跑到 007
    const db = new Database(":memory:");
    migrate001(db);
    migrate002(db);
    migrate004(db);
    migrate005(db);
    migrate006(db);
    migrate007(db);

    // 插入两个顶级 repo + 一个子模块
    db.run(
      "INSERT INTO repos (id, alias, path, default_branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["repo-001", "autopilot", "/abs/autopilot", "main", 1000, 1000]
    );
    db.run(
      "INSERT INTO repos (id, alias, path, default_branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["repo-002", "clawmo", "/abs/clawmo", "main", 2000, 2000]
    );
    db.run(
      "INSERT INTO repos (id, alias, path, default_branch, parent_repo_id, submodule_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["repo-003", "shared-sdk", "/abs/clawmo/sdk", "main", "repo-002", "sdk", 2100, 2100]
    );

    // 跑 008
    migrate008(db);

    // 断言：建了 2 个 project
    const projs = db.query<{ id: string; name: string }, []>(
      "SELECT id, name FROM projects ORDER BY name"
    ).all();
    expect(projs.length).toBe(2);
    expect(projs.map(p => p.name).sort()).toEqual(["autopilot", "clawmo"]);

    // 断言：所有 codebase 行都有 project_id（NULL 检查）
    const cbs = db.query<{ id: string; alias: string; project_id: string; parent_codebase_id: string | null }, []>(
      "SELECT id, alias, project_id, parent_codebase_id FROM codebases ORDER BY id"
    ).all();
    expect(cbs.every(c => c.project_id !== null)).toBe(true);

    // 断言：ID 前缀 repo-NNN → cb-NNN
    expect(cbs.map(c => c.id).sort()).toEqual(["cb-001", "cb-002", "cb-003"]);

    // 断言：父子模块的 parent_codebase_id 也已转前缀
    const sub = cbs.find(c => c.alias === "shared-sdk");
    expect(sub?.parent_codebase_id).toBe("cb-002");

    // 断言：父+子模块同 project
    const parent = cbs.find(c => c.alias === "clawmo");
    expect(sub?.project_id).toBe(parent?.project_id);
  });
});

describe("migration 008-projects · requirements 表升级", () => {
  it("requirements 表 repo_id rename 为 codebase_id，并加 project_id", () => {
    const db = new Database(":memory:");
    migrate001(db);
    migrate002(db);
    migrate004(db);
    migrate005(db);
    migrate006(db);
    migrate007(db);

    // 插入 1 个 repo + 1 个 requirement 引用它
    db.run(
      "INSERT INTO repos (id, alias, path, default_branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["repo-001", "autopilot", "/abs/autopilot", "main", 1000, 1000]
    );
    db.run(
      "INSERT INTO requirements (id, repo_id, title, status, spec_md, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["req-001", "repo-001", "测试需求", "drafting", "...", 1500, 1500]
    );

    migrate008(db);

    const cols = db.query<{ name: string }, []>(
      "PRAGMA table_info(requirements)"
    ).all().map(c => c.name);

    expect(cols).toContain("codebase_id");
    expect(cols).not.toContain("repo_id");
    expect(cols).toContain("project_id");
  });

  it("旧 requirement.repo_id 值已转为 cb-NNN，project_id 已填", () => {
    const db = new Database(":memory:");
    migrate001(db);
    migrate002(db);
    migrate004(db);
    migrate005(db);
    migrate006(db);
    migrate007(db);

    db.run(
      "INSERT INTO repos (id, alias, path, default_branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["repo-001", "autopilot", "/abs/autopilot", "main", 1000, 1000]
    );
    db.run(
      "INSERT INTO requirements (id, repo_id, title, status, spec_md, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["req-001", "repo-001", "测试", "drafting", "...", 1500, 1500]
    );

    migrate008(db);

    const r = db.query<{ codebase_id: string; project_id: string }, []>(
      "SELECT codebase_id, project_id FROM requirements WHERE id = 'req-001'"
    ).get();
    expect(r?.codebase_id).toBe("cb-001");
    expect(r?.project_id?.startsWith("proj-")).toBe(true);
  });
});

describe("migration 008-projects · 数据后处理", () => {
  it("自动给每个有 codebase_id 的 requirement 写 requirement_codebases 关联", () => {
    const db = freshDb();

    db.run(
      "INSERT INTO repos (id, alias, path, default_branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["repo-001", "a", "/p", "main", 1000, 1000]
    );
    db.run(
      "INSERT INTO requirements (id, repo_id, title, status, spec_md, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["req-001", "repo-001", "x", "drafting", "", 1500, 1500]
    );

    migrate008(db);

    const links = db.query<{ requirement_id: string; codebase_id: string }, []>(
      "SELECT requirement_id, codebase_id FROM requirement_codebases"
    ).all();
    expect(links).toEqual([{ requirement_id: "req-001", codebase_id: "cb-001" }]);
  });

  it("旧 ready / queued 状态自动转 awaiting_approval", () => {
    const db = freshDb();

    db.run(
      "INSERT INTO repos (id, alias, path, default_branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["repo-001", "a", "/p", "main", 1000, 1000]
    );
    db.run(
      "INSERT INTO requirements (id, repo_id, title, status, spec_md, created_at, updated_at) VALUES ('req-r', 'repo-001', 'r', 'ready', '', 1500, 1500)"
    );
    db.run(
      "INSERT INTO requirements (id, repo_id, title, status, spec_md, created_at, updated_at) VALUES ('req-q', 'repo-001', 'q', 'queued', '', 1500, 1500)"
    );
    db.run(
      "INSERT INTO requirements (id, repo_id, title, status, spec_md, created_at, updated_at) VALUES ('req-d', 'repo-001', 'd', 'done', '', 1500, 1500)"
    );

    migrate008(db);

    const statuses = db.query<{ id: string; status: string }, []>(
      "SELECT id, status FROM requirements ORDER BY id"
    ).all();
    expect(statuses).toEqual([
      { id: "req-d", status: "done" },                  // 终态不动
      { id: "req-q", status: "awaiting_approval" },     // queued → awaiting_approval
      { id: "req-r", status: "awaiting_approval" },     // ready → awaiting_approval
    ]);
  });
});

describe("migration 008-projects · requirement_sub_prs 升级", () => {
  it("child_repo_id rename 为 child_codebase_id，ID 前缀转换", () => {
    const db = freshDb();

    db.run(
      "INSERT INTO repos (id, alias, path, default_branch, created_at, updated_at) VALUES ('repo-001', 'a', '/p', 'main', 1000, 1000)"
    );
    db.run(
      "INSERT INTO repos (id, alias, path, default_branch, parent_repo_id, submodule_path, created_at, updated_at) VALUES ('repo-002', 's', '/p/s', 'main', 'repo-001', 's', 1100, 1100)"
    );
    db.run(
      "INSERT INTO requirements (id, repo_id, title, status, spec_md, created_at, updated_at) VALUES ('req-001', 'repo-001', 'x', 'drafting', '', 1500, 1500)"
    );
    db.run(
      "INSERT INTO requirement_sub_prs (requirement_id, child_repo_id, pr_url, pr_number, created_at) VALUES ('req-001', 'repo-002', 'http://x', 42, 1600)"
    );

    migrate008(db);

    const cols = db.query<{ name: string }, []>(
      "PRAGMA table_info(requirement_sub_prs)"
    ).all().map(c => c.name);
    expect(cols).toContain("child_codebase_id");
    expect(cols).not.toContain("child_repo_id");

    const row = db.query<{ child_codebase_id: string }, []>(
      "SELECT child_codebase_id FROM requirement_sub_prs WHERE requirement_id = 'req-001'"
    ).get();
    expect(row?.child_codebase_id).toBe("cb-002");
  });
});
