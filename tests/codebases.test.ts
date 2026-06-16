import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  createWorkspace,
  getWorkspaceById,
  getWorkspaceByAlias,
  listWorkspaces,
  updateWorkspace,
  deleteWorkspace,
  nextWorkspaceId,
} from "../src/core/sandbox/workspaces";
import { createProject } from "../src/core/projects";
import { createRequirement, getRequirementById } from "../src/core/requirements";
import { _setDbForTest, initDb } from "../src/core/db";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate002 } from "../src/migrations/002-schedules";
import { up as migrate004 } from "../src/migrations/004-repos";
import { up as migrate005 } from "../src/migrations/005-requirements";
import { up as migrate006 } from "../src/migrations/006-submodules";
import { up as migrate007 } from "../src/migrations/007-workflows";
import { up as migrate008 } from "../src/migrations/008-projects";
import { up as migrate009 } from "../src/migrations/009-nullable-codebase";
import { up as migrate010 } from "../src/migrations/010-question-suggestions";
import { up as migrate011 } from "../src/migrations/011-now-dismissed-cards";
import { up as migrate024 } from "../src/migrations/024-codebase-to-workspace";
import { up as migrate033 } from "../src/migrations/033-workspace-remote-url";
import { checkWorkspaceHealth, parseGithubFromRemote, detectWorkspaceGit, redactRemoteUrl } from "../src/core/sandbox/workspace-health";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// 注意：initDb() 不接受路径参数，通过 _setDbForTest 注入内存 DB，
// 再手动执行各迁移脚本，确保 workspaces 表（及上游依赖）存在且与迁移定义一致。

function runAllMigrations(db: Database): void {
  migrate001(db);
  migrate002(db);
  migrate004(db);
  migrate005(db);
  migrate006(db);
  migrate007(db);
  migrate008(db);
  migrate009(db);
  migrate010(db);
  migrate011(db);
  migrate024(db);
  migrate033(db);
}

describe("migration produces workspaces table", () => {
  it("含约定的 12 个字段", () => {
    const db = new Database(":memory:");
    runAllMigrations(db);
    const cols = db
      .query<{ name: string }, []>("PRAGMA table_info(workspaces)")
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
      "parent_workspace_id",
      "path",
      "project_id",
      "remote_url",
      "submodule_path",
      "updated_at",
    ]);
  });
});

describe("workspaces CRUD", () => {
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

  it("createWorkspace + getWorkspaceById + getWorkspaceByAlias", () => {
    const created = createWorkspace({
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

    const byId = getWorkspaceById("cb-001");
    expect(byId?.alias).toBe("autopilot");
    expect(byId?.path).toBe("/tmp/autopilot");
    expect(typeof byId?.created_at).toBe("number");

    const byAlias = getWorkspaceByAlias(projId, "autopilot");
    expect(byAlias?.id).toBe("cb-001");
  });

  it("alias 在同 project 内重复时报错（UNIQUE 约束）", () => {
    expect(() => {
      createWorkspace({
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
      createWorkspace({
        id: "cb-100",
        project_id: p2.id,
        alias: "autopilot", // 跟 proj-test 同名
        path: "/tmp/shared",
      });
    }).not.toThrow();
  });

  it("listWorkspaces 按 created_at 升序", () => {
    const cb3 = createWorkspace({ id: "cb-003", project_id: projId, alias: "alpha", path: "/tmp/a" });
    const cb4 = createWorkspace({ id: "cb-004", project_id: projId, alias: "beta", path: "/tmp/b" });
    expect(cb3.id).toBe("cb-003");
    expect(cb4.id).toBe("cb-004");
    const all = listWorkspaces({ projectId: projId });
    expect(all.length).toBeGreaterThanOrEqual(3);
    expect(all[0].id).toBe("cb-001");
  });

  it("updateWorkspace 更新可变字段", () => {
    const before = getWorkspaceById("cb-001");
    const updated = updateWorkspace("cb-001", { path: "/new/path", default_branch: "develop" });
    expect(updated?.path).toBe("/new/path");
    expect(updated?.default_branch).toBe("develop");
    expect(updated?.updated_at).toBeGreaterThanOrEqual(before?.updated_at ?? 0);
  });

  it("updateWorkspace 空 opts 是 no-op", () => {
    const before = getWorkspaceById("cb-001");
    const after = updateWorkspace("cb-001", {});
    expect(after?.path).toBe(before?.path);
    expect(after?.updated_at).toBe(before?.updated_at);
  });

  it("deleteWorkspace 删除", () => {
    deleteWorkspace("cb-003");
    expect(getWorkspaceById("cb-003")).toBeNull();
  });

  it("nextWorkspaceId 自增（ws-NNN 格式）", () => {
    const next = nextWorkspaceId();
    expect(next).toMatch(/^ws-\d{3}$/);
  });
});

describe("checkWorkspaceHealth", () => {
  it("路径不存在 → healthy=false", async () => {
    const r = await checkWorkspaceHealth("/no/such/path/abcxyz123456");
    expect(r.healthy).toBe(false);
    expect(r.issues.some((i) => i.includes("不存在"))).toBe(true);
  });

  it("路径存在但不是 git 仓库 → healthy=false", async () => {
    const dir = mkdtempSync(join(tmpdir(), "health-test-"));
    try {
      const r = await checkWorkspaceHealth(dir);
      expect(r.healthy).toBe(false);
      expect(r.issues.some((i) => i.includes("git"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("autopilot 仓库本身健康（或仅 issue 为远端相关）", async () => {
    const r = await checkWorkspaceHealth(process.cwd());
    // 在 CI 或无远端环境，可能 origin 不可达；这是 OK 的
    expect(r.healthy === true || r.issues.every((i) => i.includes("远端"))).toBe(true);
  });
});

describe("detectWorkspaceGit", () => {
  // 隔离宿主全局/系统 git 配置（如 insteadOf 把 PAT 注入 remote URL），
  // 否则 detect 读到的 remote_url 会被污染、测试不可复现（H2）。
  let savedGlobal: string | undefined;
  let savedSystem: string | undefined;
  beforeAll(() => {
    savedGlobal = process.env.GIT_CONFIG_GLOBAL;
    savedSystem = process.env.GIT_CONFIG_SYSTEM;
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  });
  afterAll(() => {
    if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
    if (savedSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM;
    else process.env.GIT_CONFIG_SYSTEM = savedSystem;
  });

  function git(dir: string, args: string[]): void {
    const r = Bun.spawnSync(["git", ...args], { cwd: dir, stderr: "pipe", stdout: "pipe" });
    if (r.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} 失败：${new TextDecoder().decode(r.stderr)}`);
    }
  }

  it("非 git 路径 → is_git=false，全 null", () => {
    const dir = mkdtempSync(join(tmpdir(), "detect-nogit-"));
    try {
      const info = detectWorkspaceGit(dir);
      expect(info.is_git).toBe(false);
      expect(info.default_branch).toBeNull();
      expect(info.remote_url).toBeNull();
      expect(info.github_owner).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("路径不存在 → is_git=false", () => {
    expect(detectWorkspaceGit("/no/such/path/xyz987").is_git).toBe(false);
  });

  it("本地 git 仓库 → 探测到当前分支（无 origin 时 github 为 null）", () => {
    const dir = mkdtempSync(join(tmpdir(), "detect-local-"));
    try {
      git(dir, ["init", "-b", "develop"]);
      git(dir, ["config", "user.email", "t@t.io"]);
      git(dir, ["config", "user.name", "t"]);
      Bun.spawnSync(["git", "commit", "--allow-empty", "-m", "init"], { cwd: dir });
      const info = detectWorkspaceGit(dir);
      expect(info.is_git).toBe(true);
      expect(info.default_branch).toBe("develop"); // 无 origin/HEAD，回退当前分支
      expect(info.github_owner).toBeNull();
      expect(info.remote_url).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("配了 github origin → 解析出 owner/repo + remote_url 原文", () => {
    const dir = mkdtempSync(join(tmpdir(), "detect-remote-"));
    try {
      git(dir, ["init", "-b", "main"]);
      git(dir, ["remote", "add", "origin", "https://github.com/acme/widget.git"]);
      const info = detectWorkspaceGit(dir);
      expect(info.is_git).toBe(true);
      expect(info.remote_url).toBe("https://github.com/acme/widget.git");
      expect(info.github_owner).toBe("acme");
      expect(info.github_repo).toBe("widget");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("带凭据的 origin URL → remote_url 脱敏，不泄露 token（H2）", () => {
    const dir = mkdtempSync(join(tmpdir(), "detect-creds-"));
    try {
      git(dir, ["init", "-b", "main"]);
      git(dir, ["remote", "add", "origin", "https://x-access-token:ghp_FAKE12345@github.com/acme/widget.git"]);
      const info = detectWorkspaceGit(dir);
      expect(info.remote_url).toBe("https://github.com/acme/widget.git");
      expect(info.remote_url ?? "").not.toContain("ghp_FAKE12345");
      expect(info.github_owner).toBe("acme");
      expect(info.github_repo).toBe("widget");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("redactRemoteUrl（H2 凭据脱敏）", () => {
  it("剥 https user:token 凭据", () => {
    expect(redactRemoteUrl("https://x-access-token:ghp_FAKE@github.com/o/r.git")).toBe(
      "https://github.com/o/r.git",
    );
  });
  it("剥 https 单段 token（token 作 user）", () => {
    expect(redactRemoteUrl("https://ghp_FAKE@github.com/o/r.git")).toBe("https://github.com/o/r.git");
  });
  it("无凭据的 https 不变", () => {
    expect(redactRemoteUrl("https://github.com/o/r.git")).toBe("https://github.com/o/r.git");
  });
  it("scp-style git@host 保留（git 是公开用户名非凭据）", () => {
    expect(redactRemoteUrl("git@github.com:o/r.git")).toBe("git@github.com:o/r.git");
  });
  it("path 里的 @ 不被误剥", () => {
    expect(redactRemoteUrl("https://github.com/o/r@v1.git")).toBe("https://github.com/o/r@v1.git");
  });
  it("null → null", () => {
    expect(redactRemoteUrl(null)).toBeNull();
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

describe("workspaces submodule 字段（P5.1 → P1 改名后）", () => {
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
    db.run("DELETE FROM workspaces");
  });

  it("createWorkspace 接受 parent_workspace_id + submodule_path", () => {
    createWorkspace({
      id: "cb-parent",
      project_id: projId,
      alias: "parent",
      path: "/tmp/parent",
    });
    createWorkspace({
      id: "cb-child",
      project_id: projId,
      alias: "child",
      path: "/tmp/parent/child",
      parent_workspace_id: "cb-parent",
      submodule_path: "child",
    });
    const child = getWorkspaceById("cb-child");
    expect(child?.parent_workspace_id).toBe("cb-parent");
    expect(child?.submodule_path).toBe("child");
    const parent = getWorkspaceById("cb-parent");
    expect(parent?.parent_workspace_id).toBeNull();
    expect(parent?.submodule_path).toBeNull();
  });

  it("listWorkspaces 默认不含子模块（仅父 codebase）", () => {
    createWorkspace({ id: "cb-parent", project_id: projId, alias: "parent", path: "/tmp/parent" });
    createWorkspace({
      id: "cb-child",
      project_id: projId,
      alias: "child",
      path: "/tmp/parent/child",
      parent_workspace_id: "cb-parent",
      submodule_path: "child",
    });
    const list = listWorkspaces({ projectId: projId });
    expect(list.find((c) => c.id === "cb-child")).toBeUndefined();
    expect(list.find((c) => c.id === "cb-parent")).toBeDefined();
  });

  it("listWorkspaces({ includeSubmodules: true }) 含全部", () => {
    createWorkspace({ id: "cb-parent", project_id: projId, alias: "parent", path: "/tmp/parent" });
    createWorkspace({
      id: "cb-child",
      project_id: projId,
      alias: "child",
      path: "/tmp/parent/child",
      parent_workspace_id: "cb-parent",
      submodule_path: "child",
    });
    const list = listWorkspaces({ projectId: projId, includeSubmodules: true });
    expect(list.find((c) => c.id === "cb-child")).toBeDefined();
    expect(list.find((c) => c.id === "cb-parent")).toBeDefined();
  });

  it("deleteWorkspace 级联删子模块", () => {
    createWorkspace({ id: "cb-parent", project_id: projId, alias: "parent", path: "/tmp/parent" });
    createWorkspace({
      id: "cb-child",
      project_id: projId,
      alias: "child",
      path: "/tmp/parent/child",
      parent_workspace_id: "cb-parent",
      submodule_path: "child",
    });
    deleteWorkspace("cb-parent");
    expect(getWorkspaceById("cb-parent")).toBeNull();
    expect(getWorkspaceById("cb-child")).toBeNull();
  });

  it("deleteWorkspace 把指向它的 requirement.workspace_id 置 NULL + 清 join", async () => {
    const db = (await import("../src/core/db")).getDb();

    createWorkspace({ id: "cb-del", project_id: projId, alias: "del-main", path: "/tmp/del" });
    createRequirement({ id: "REQ-CB1", project_id: projId, workspace_id: "cb-del", title: "X", spec_md: "" });

    // 验证 requirement 持有 workspace_id 引用
    let req = getRequirementById("REQ-CB1");
    expect(req?.workspace_id).toBe("cb-del");

    deleteWorkspace("cb-del");

    // codebase 已删
    expect(db.query("SELECT COUNT(*) AS n FROM workspaces WHERE id = 'cb-del'").get()).toEqual({ n: 0 });
    // requirement 还在，但 workspace_id 已置 NULL
    req = getRequirementById("REQ-CB1");
    expect(req).not.toBeNull();
    expect(req?.workspace_id).toBeNull();
    // requirement_workspaces 关联也清
    expect(db.query("SELECT COUNT(*) AS n FROM requirement_workspaces WHERE workspace_id = 'cb-del'").get()).toEqual({ n: 0 });
  });
});
