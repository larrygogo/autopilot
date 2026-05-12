import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  createCodebase,
  getCodebaseById,
  getCodebaseByAlias,
  listCodebases,
  updateCodebase,
  deleteCodebase,
  nextCodebaseId,
} from "../src/core/codebases";
import { createProject } from "../src/core/projects";
import { _setDbForTest, initDb } from "../src/core/db";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate002 } from "../src/migrations/002-schedules";
import { up as migrate004 } from "../src/migrations/004-repos";
import { up as migrate005 } from "../src/migrations/005-requirements";
import { up as migrate006 } from "../src/migrations/006-submodules";
import { up as migrate007 } from "../src/migrations/007-workflows";
import { up as migrate008 } from "../src/migrations/008-projects";
import { checkCodebaseHealth, parseGithubFromRemote } from "../src/core/codebase-health";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// 注意：initDb() 不接受路径参数，通过 _setDbForTest 注入内存 DB，
// 再手动执行各迁移脚本，确保 codebases 表（及上游依赖）存在且与迁移定义一致。

function runAllMigrations(db: Database): void {
  migrate001(db);
  migrate002(db);
  migrate004(db);
  migrate005(db);
  migrate006(db);
  migrate007(db);
  migrate008(db);
}

describe("migration produces codebases table", () => {
  it("含约定的 11 个字段", () => {
    const db = new Database(":memory:");
    runAllMigrations(db);
    const cols = db
      .query<{ name: string }, []>("PRAGMA table_info(codebases)")
      .all()
      .map((c) => c.name)
      .sort();
    expect(cols).toEqual([
      "alias",
      "created_at",
      "default_branch",
      "github_owner",
      "github_repo",
      "id",
      "parent_codebase_id",
      "path",
      "project_id",
      "submodule_path",
      "updated_at",
    ]);
  });
});

describe("codebases CRUD", () => {
  let sqlite: Database;
  let projId: string;

  beforeAll(() => {
    sqlite = new Database(":memory:");
    _setDbForTest(sqlite);
    // 执行基础 PRAGMA 和 tasks/task_logs 表（initDb 内部调用 getDb()，会用注入的实例）
    initDb();
    runAllMigrations(sqlite);
    const p = createProject({ id: "proj-test", name: "test" });
    projId = p.id;
  });

  afterAll(() => {
    _setDbForTest(null);
    sqlite.close();
  });

  it("createCodebase + getCodebaseById + getCodebaseByAlias", () => {
    const created = createCodebase({
      id: "cb-001",
      project_id: projId,
      alias: "autopilot",
      path: "/tmp/autopilot",
      default_branch: "main",
      github_owner: "larrygogo",
      github_repo: "autopilot",
    });

    expect(created.alias).toBe("autopilot");
    expect(created.project_id).toBe(projId);
    expect(created.path).toBe("/tmp/autopilot");
    expect(typeof created.created_at).toBe("number");

    const byId = getCodebaseById("cb-001");
    expect(byId?.alias).toBe("autopilot");
    expect(byId?.path).toBe("/tmp/autopilot");
    expect(typeof byId?.created_at).toBe("number");

    const byAlias = getCodebaseByAlias(projId, "autopilot");
    expect(byAlias?.id).toBe("cb-001");
  });

  it("alias 在同 project 内重复时报错（UNIQUE 约束）", () => {
    expect(() => {
      createCodebase({
        id: "cb-002",
        project_id: projId,
        alias: "autopilot",
        path: "/tmp/another",
      });
    }).toThrow();
  });

  it("alias 在不同 project 间允许重复", () => {
    const p2 = createProject({ id: "proj-other", name: "other" });
    expect(() => {
      createCodebase({
        id: "cb-100",
        project_id: p2.id,
        alias: "autopilot", // 跟 proj-test 同名
        path: "/tmp/shared",
      });
    }).not.toThrow();
  });

  it("listCodebases 按 created_at 升序", () => {
    const cb3 = createCodebase({ id: "cb-003", project_id: projId, alias: "alpha", path: "/tmp/a" });
    const cb4 = createCodebase({ id: "cb-004", project_id: projId, alias: "beta", path: "/tmp/b" });
    expect(cb3.id).toBe("cb-003");
    expect(cb4.id).toBe("cb-004");
    const all = listCodebases({ projectId: projId });
    expect(all.length).toBeGreaterThanOrEqual(3);
    expect(all[0].id).toBe("cb-001");
  });

  it("updateCodebase 更新可变字段", () => {
    const before = getCodebaseById("cb-001");
    const updated = updateCodebase("cb-001", { path: "/new/path", default_branch: "develop" });
    expect(updated?.path).toBe("/new/path");
    expect(updated?.default_branch).toBe("develop");
    expect(updated?.updated_at).toBeGreaterThanOrEqual(before?.updated_at ?? 0);
  });

  it("updateCodebase 空 opts 是 no-op", () => {
    const before = getCodebaseById("cb-001");
    const after = updateCodebase("cb-001", {});
    expect(after?.path).toBe(before?.path);
    expect(after?.updated_at).toBe(before?.updated_at);
  });

  it("deleteCodebase 删除", () => {
    deleteCodebase("cb-003");
    expect(getCodebaseById("cb-003")).toBeNull();
  });

  it("nextCodebaseId 自增（cb-NNN 格式）", () => {
    const next = nextCodebaseId();
    expect(next).toMatch(/^cb-\d{3}$/);
  });
});

describe("checkCodebaseHealth", () => {
  it("路径不存在 → healthy=false", async () => {
    const r = await checkCodebaseHealth("/no/such/path/abcxyz123456");
    expect(r.healthy).toBe(false);
    expect(r.issues.some((i) => i.includes("不存在"))).toBe(true);
  });

  it("路径存在但不是 git 仓库 → healthy=false", async () => {
    const dir = mkdtempSync(join(tmpdir(), "health-test-"));
    try {
      const r = await checkCodebaseHealth(dir);
      expect(r.healthy).toBe(false);
      expect(r.issues.some((i) => i.includes("git"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("autopilot 仓库本身健康（或仅 issue 为远端相关）", async () => {
    const r = await checkCodebaseHealth(process.cwd());
    // 在 CI 或无远端环境，可能 origin 不可达；这是 OK 的
    expect(r.healthy === true || r.issues.every((i) => i.includes("远端"))).toBe(true);
  });
});

describe("parseGithubFromRemote", () => {
  it("解析 https URL", () => {
    expect(parseGithubFromRemote("https://github.com/larrygogo/autopilot.git")).toEqual({
      owner: "larrygogo",
      repo: "autopilot",
    });
  });
  it("解析 https URL 不带 .git 后缀", () => {
    expect(parseGithubFromRemote("https://github.com/larrygogo/autopilot")).toEqual({
      owner: "larrygogo",
      repo: "autopilot",
    });
  });
  it("解析 ssh URL", () => {
    expect(parseGithubFromRemote("git@github.com:larrygogo/autopilot.git")).toEqual({
      owner: "larrygogo",
      repo: "autopilot",
    });
  });
  it("非 GitHub 远端返回 null", () => {
    expect(parseGithubFromRemote("https://gitlab.com/foo/bar.git")).toBeNull();
  });
  it("空字符串返回 null", () => {
    expect(parseGithubFromRemote("")).toBeNull();
  });

  it("解析仓库名带点（autopilot.js）", () => {
    expect(parseGithubFromRemote("https://github.com/larrygogo/autopilot.js.git")).toEqual({
      owner: "larrygogo",
      repo: "autopilot.js",
    });
    expect(parseGithubFromRemote("https://github.com/larrygogo/autopilot.js")).toEqual({
      owner: "larrygogo",
      repo: "autopilot.js",
    });
  });

  it("解析 https 带 trailing slash", () => {
    expect(parseGithubFromRemote("https://github.com/larrygogo/autopilot/")).toEqual({
      owner: "larrygogo",
      repo: "autopilot",
    });
  });

  it("解析 ssh:// 协议形式", () => {
    expect(parseGithubFromRemote("ssh://git@github.com/larrygogo/autopilot.git")).toEqual({
      owner: "larrygogo",
      repo: "autopilot",
    });
  });

  it("解析带凭证的 https URL", () => {
    expect(parseGithubFromRemote("https://x-access-token:ghp_xxx@github.com/larrygogo/autopilot.git")).toEqual({
      owner: "larrygogo",
      repo: "autopilot",
    });
  });

  it("大小写不敏感", () => {
    expect(parseGithubFromRemote("HTTPS://GitHub.com/larrygogo/autopilot.git")).toEqual({
      owner: "larrygogo",
      repo: "autopilot",
    });
  });
});

describe("codebases submodule 字段（P5.1 → P1 改名后）", () => {
  let db: Database;
  let projId: string;

  beforeAll(() => {
    db = new Database(":memory:");
    _setDbForTest(db);
    initDb();
    runAllMigrations(db);
    const p = createProject({ id: "proj-sub", name: "sub" });
    projId = p.id;
  });

  afterAll(() => {
    _setDbForTest(null);
    db.close();
  });

  beforeEach(() => {
    // 清表避免 case 污染
    db.run("DELETE FROM codebases");
  });

  it("createCodebase 接受 parent_codebase_id + submodule_path", () => {
    createCodebase({
      id: "cb-parent",
      project_id: projId,
      alias: "parent",
      path: "/tmp/parent",
    });
    createCodebase({
      id: "cb-child",
      project_id: projId,
      alias: "child",
      path: "/tmp/parent/child",
      parent_codebase_id: "cb-parent",
      submodule_path: "child",
    });
    const child = getCodebaseById("cb-child");
    expect(child?.parent_codebase_id).toBe("cb-parent");
    expect(child?.submodule_path).toBe("child");
    const parent = getCodebaseById("cb-parent");
    expect(parent?.parent_codebase_id).toBeNull();
    expect(parent?.submodule_path).toBeNull();
  });

  it("listCodebases 默认不含子模块（仅父 codebase）", () => {
    createCodebase({ id: "cb-parent", project_id: projId, alias: "parent", path: "/tmp/parent" });
    createCodebase({
      id: "cb-child",
      project_id: projId,
      alias: "child",
      path: "/tmp/parent/child",
      parent_codebase_id: "cb-parent",
      submodule_path: "child",
    });
    const list = listCodebases({ projectId: projId });
    expect(list.find((c) => c.id === "cb-child")).toBeUndefined();
    expect(list.find((c) => c.id === "cb-parent")).toBeDefined();
  });

  it("listCodebases({ includeSubmodules: true }) 含全部", () => {
    createCodebase({ id: "cb-parent", project_id: projId, alias: "parent", path: "/tmp/parent" });
    createCodebase({
      id: "cb-child",
      project_id: projId,
      alias: "child",
      path: "/tmp/parent/child",
      parent_codebase_id: "cb-parent",
      submodule_path: "child",
    });
    const list = listCodebases({ projectId: projId, includeSubmodules: true });
    expect(list.find((c) => c.id === "cb-child")).toBeDefined();
    expect(list.find((c) => c.id === "cb-parent")).toBeDefined();
  });

  it("deleteCodebase 级联删子模块", () => {
    createCodebase({ id: "cb-parent", project_id: projId, alias: "parent", path: "/tmp/parent" });
    createCodebase({
      id: "cb-child",
      project_id: projId,
      alias: "child",
      path: "/tmp/parent/child",
      parent_codebase_id: "cb-parent",
      submodule_path: "child",
    });
    deleteCodebase("cb-parent");
    expect(getCodebaseById("cb-parent")).toBeNull();
    expect(getCodebaseById("cb-child")).toBeNull();
  });
});
