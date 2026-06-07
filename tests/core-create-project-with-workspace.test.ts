import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { _setDbForTest, initDb } from "../src/core/db";
import { up as m001 } from "../src/migrations/001-baseline";
import { up as m002 } from "../src/migrations/002-schedules";
import { up as m004 } from "../src/migrations/004-repos";
import { up as m005 } from "../src/migrations/005-requirements";
import { up as m006 } from "../src/migrations/006-submodules";
import { up as m007 } from "../src/migrations/007-workflows";
import { up as m008 } from "../src/migrations/008-projects";
import { up as m009 } from "../src/migrations/009-nullable-codebase";
import { up as m010 } from "../src/migrations/010-question-suggestions";
import { up as m011 } from "../src/migrations/011-now-dismissed-cards";
import { up as m019 } from "../src/migrations/019-task-requirement-id";
import { up as m021 } from "../src/migrations/021-requirement-comments";
import { up as m024 } from "../src/migrations/024-codebase-to-workspace";
import { up as m025 } from "../src/migrations/025-one-workspace-per-project";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { deriveAlias, resolveUniqueAlias, createWorkspace } from "../src/core/workspaces";
import { createProjectWithWorkspace } from "../src/core/projects";

let sqlite: Database;
let tmpDir: string;

beforeAll(() => {
  sqlite = new Database(":memory:");
  _setDbForTest(sqlite);
  initDb();
  m001(sqlite); m002(sqlite); m004(sqlite); m005(sqlite);
  m006(sqlite); m007(sqlite); m008(sqlite); m009(sqlite);
  m010(sqlite); m011(sqlite); m019(sqlite); m021(sqlite);
  m024(sqlite); m025(sqlite);
  tmpDir = mkdtempSync(tmpdir() + "/autopilot-core-test-");
});

afterAll(() => {
  _setDbForTest(null);
  sqlite.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── 1. deriveAlias（纯函数，无 DB）──────────────────────────────────

describe("deriveAlias", () => {
  it("从 POSIX 路径取末尾目录名", () => {
    expect(deriveAlias("/code/myapp")).toBe("myapp");
  });
  it("忽略 POSIX 结尾斜杠", () => {
    expect(deriveAlias("/code/myapp/")).toBe("myapp");
  });
  it("Windows 路径（反斜杠）正确解析", () => {
    expect(deriveAlias("C:\\Users\\larry\\projects\\myapp")).toBe("myapp");
  });
  it("路径为空字符串时返回 'workspace' 兜底", () => {
    expect(deriveAlias("")).toBe("workspace");
  });
  it("单层路径（无分隔符）原样返回", () => {
    expect(deriveAlias("myapp")).toBe("myapp");
  });
});

// ── 2. resolveUniqueAlias（需要 DB）──────────────────────────────────

describe("resolveUniqueAlias", () => {
  it("无冲突时直接返回原始 alias", () => {
    expect(resolveUniqueAlias("no-conflict-alias-xyz")).toBe("no-conflict-alias-xyz");
  });

  it("已存在同名 alias（任意项目）时自动追加 -2", () => {
    // 用数字格式 ID 避免干扰 nextWorkspaceId()；每个 workspace 用不同 project_id 避免 1:1 约束
    createWorkspace({ id: "ws-800", project_id: "proj-resolve-1", alias: "conflict-base", path: "/tmp/t1" });
    expect(resolveUniqueAlias("conflict-base")).toBe("conflict-base-2");
  });

  it("已存在 foo 和 foo-2 时返回 foo-3", () => {
    createWorkspace({ id: "ws-801", project_id: "proj-resolve-2", alias: "conflict-base-2", path: "/tmp/t2" });
    expect(resolveUniqueAlias("conflict-base")).toBe("conflict-base-3");
  });

  it("去重跨项目（全局）：proj-a 下的 alias 阻止 proj-b 使用同名", () => {
    createWorkspace({ id: "ws-802", project_id: "proj-resolve-a", alias: "cross-proj-alias", path: "/tmp/t3" });
    // 即使在不同 project_id 下，全局也不允许重复
    const result = resolveUniqueAlias("cross-proj-alias");
    expect(result).toBe("cross-proj-alias-2");
  });
});

// ── 3. createProjectWithWorkspace（集成 Core 层）──────────────────────

describe("createProjectWithWorkspace", () => {
  it("非 git 目录也能成功建 project + workspace", () => {
    const dir = mkdtempSync(tmpDir + "/plain-dir-");
    const { project, workspace } = createProjectWithWorkspace({
      name: "PlainDirProject",
      path: dir,
    });
    expect(project.id).toMatch(/^proj-/);
    expect(project.name).toBe("PlainDirProject");
    expect(workspace.id).toMatch(/^ws-/);
    expect(workspace.project_id).toBe(project.id);
    expect(workspace.path).toBe(dir);
  });

  it("不提供 alias 时从 path 末尾目录名推导", () => {
    const dir = mkdtempSync(tmpDir + "/known-name-");
    const baseName = dir.split(/[\\/]/).pop()!;
    const { workspace } = createProjectWithWorkspace({
      name: "AliasFromPathProject",
      path: dir,
    });
    // alias 可能已追加后缀（-2 等），但必须以原始目录名开头
    expect(workspace.alias.startsWith(baseName)).toBe(true);
  });

  it("显式传入 alias 时使用用户指定值", () => {
    const dir = mkdtempSync(tmpDir + "/explicit-");
    const { workspace } = createProjectWithWorkspace({
      name: "ExplicitAliasProject",
      path: dir,
      alias: "my-explicit-alias",
    });
    expect(workspace.alias).toBe("my-explicit-alias");
  });

  it("alias 冲突时第二次调用自动追加后缀（对调用方透明）", () => {
    const dir1 = mkdtempSync(tmpDir + "/clash-");
    const dir2 = mkdtempSync(tmpDir + "/clash-");
    const { workspace: ws1 } = createProjectWithWorkspace({
      name: "ClashProject1",
      path: dir1,
      alias: "clash-alias",
    });
    const { workspace: ws2 } = createProjectWithWorkspace({
      name: "ClashProject2",
      path: dir2,
      alias: "clash-alias",
    });
    expect(ws1.alias).toBe("clash-alias");
    expect(ws2.alias).toBe("clash-alias-2");
    // 两者隶属不同 project
    expect(ws1.project_id).not.toBe(ws2.project_id);
  });

  it("project 和 workspace 在同一事务：两者必须同时存在", () => {
    const dir = mkdtempSync(tmpDir + "/tx-test-");
    const before = {
      projects: (sqlite.query<{ n: number }, []>("SELECT COUNT(*) as n FROM projects").get()!).n,
      workspaces: (sqlite.query<{ n: number }, []>("SELECT COUNT(*) as n FROM workspaces").get()!).n,
    };
    createProjectWithWorkspace({ name: "TxProject", path: dir });
    const after = {
      projects: (sqlite.query<{ n: number }, []>("SELECT COUNT(*) as n FROM projects").get()!).n,
      workspaces: (sqlite.query<{ n: number }, []>("SELECT COUNT(*) as n FROM workspaces").get()!).n,
    };
    // project 和 workspace 增量必须同步（各 +1）
    expect(after.projects - before.projects).toBe(1);
    expect(after.workspaces - before.workspaces).toBe(1);
  });

  it("workspace.default_branch 默认值为 'main'（非 git 目录）", () => {
    const dir = mkdtempSync(tmpDir + "/default-branch-");
    const { workspace } = createProjectWithWorkspace({
      name: "DefaultBranchProject",
      path: dir,
    });
    expect(workspace.default_branch).toBe("main");
  });

  it("显式传入 default_branch 时覆盖默认值", () => {
    const dir = mkdtempSync(tmpDir + "/custom-branch-");
    const { workspace } = createProjectWithWorkspace({
      name: "CustomBranchProject",
      path: dir,
      default_branch: "develop",
    });
    expect(workspace.default_branch).toBe("develop");
  });
});
