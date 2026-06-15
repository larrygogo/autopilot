/**
 * codebases.* RPC method 测试。
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate004 } from "../src/migrations/004-repos";
import { up as migrate005 } from "../src/migrations/005-requirements";
import { up as migrate006 } from "../src/migrations/006-submodules";
import { up as migrate007 } from "../src/migrations/007-workflows";
import { up as migrate008 } from "../src/migrations/008-projects";
import { up as migrate024 } from "../src/migrations/024-codebase-to-workspace";
import { up as migrate033 } from "../src/migrations/033-workspace-remote-url";
import { _setDbForTest } from "../src/core/db";
import { createWorkspace } from "../src/core/sandbox/workspaces";
import { createProject } from "../src/core/projects";
import { invokeRpcMethod } from "../src/daemon/rpc";
import { registerCoreRpcMethods } from "../src/daemon/rpc-methods";

/** 创建一个临时的 bare git 仓库，可被 git ls-remote 探测 */
function createBareRepo(): string {
  const dir = join(tmpdir(), `autopilot-bare-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  Bun.spawnSync(["git", "init", "--bare", "-q", dir], { stdout: "pipe", stderr: "pipe" });
  // bare 仓库需要至少一个引用，否则 ls-remote 拿不到 HEAD
  // 在 tmp 创建一个普通仓库，提交一次后 push 到 bare
  const work = dir + "-work";
  mkdirSync(work, { recursive: true });
  const cmds: string[][] = [
    ["git", "-C", work, "init", "-q", "-b", "main"],
    ["git", "-C", work, "config", "user.email", "test@autopilot.local"],
    ["git", "-C", work, "config", "user.name", "Test"],
    ["git", "-C", work, "commit", "--allow-empty", "-q", "-m", "init"],
    ["git", "-C", work, "remote", "add", "origin", dir],
    ["git", "-C", work, "push", "-q", "origin", "main"],
  ];
  for (const argv of cmds) Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  rmSync(work, { recursive: true, force: true });
  return dir;
}

describe("workspaces.* RPC", () => {
  let db: Database;
  let bareRepoPath: string;

  beforeAll(() => {
    db = new Database(":memory:");
    migrate001(db);
    migrate004(db);
    migrate005(db);
    migrate006(db);
    migrate007(db);
    migrate008(db);
    migrate024(db);
    migrate033(db);
    _setDbForTest(db);
    registerCoreRpcMethods();
    createProject({ id: "proj-001", name: "P" });
    bareRepoPath = createBareRepo();
  });

  afterAll(() => {
    _setDbForTest(null);
    db.close();
    if (bareRepoPath) {
      try { rmSync(bareRepoPath, { recursive: true, force: true }); } catch {}
    }
  });

  beforeEach(() => {
    db.run("DELETE FROM workspaces");
  });

  it("workspaces.list 返回数组", async () => {
    createWorkspace({ id: "cb-001", project_id: "proj-001", alias: "x", path: "/tmp/x", default_branch: "main" });
    const r = await invokeRpcMethod("workspaces.list", {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      const list = r.payload as Array<{ id: string; alias: string }>;
      expect(Array.isArray(list)).toBe(true);
      expect(list[0]?.id).toBe("cb-001");
      expect(list[0]?.alias).toBe("x");
    }
  });

  it("workspaces.create 返回裸 workspace", async () => {
    const r = await invokeRpcMethod("workspaces.create", {
      alias: "demo",
      remote_url: bareRepoPath,
      project_id: "proj-001",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const cb = r.payload as { id: string; alias: string; project_id: string };
      expect(cb.alias).toBe("demo");
      expect(cb.project_id).toBe("proj-001");
      expect(cb.id).toMatch(/^ws-/);
    }
  });

  it("workspaces.create 缺 alias/remote_url → INVALID_PARAM", async () => {
    const r = await invokeRpcMethod("workspaces.create", { alias: "demo" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_PARAM");
  });

  it("workspaces.get 返回单条", async () => {
    createWorkspace({ id: "cb-002", project_id: "proj-001", alias: "y", path: "/tmp/y", default_branch: "main" });
    const r = await invokeRpcMethod("workspaces.get", { id: "cb-002" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const cb = r.payload as { alias: string };
      expect(cb.alias).toBe("y");
    }
  });

  it("workspaces.get 不存在 → NOT_FOUND", async () => {
    const r = await invokeRpcMethod("workspaces.get", { id: "nope" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("NOT_FOUND");
  });

  it("workspaces.update 修改别名", async () => {
    createWorkspace({ id: "cb-003", project_id: "proj-001", alias: "old", path: "/tmp/o", default_branch: "main" });
    const r = await invokeRpcMethod("workspaces.update", { id: "cb-003", alias: "new" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const cb = r.payload as { alias: string };
      expect(cb.alias).toBe("new");
    }
  });

  it("workspaces.delete 返回 { ok: true } 且后续 get → NOT_FOUND", async () => {
    createWorkspace({ id: "cb-004", project_id: "proj-001", alias: "z", path: "/tmp/z", default_branch: "main" });
    const r = await invokeRpcMethod("workspaces.delete", { id: "cb-004" });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.payload as { ok: boolean }).ok).toBe(true);
    const g = await invokeRpcMethod("workspaces.get", { id: "cb-004" });
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.error.code).toBe("NOT_FOUND");
  });

  it("workspaces.listSubmodules 返回 { submodules: [...] }", async () => {
    createWorkspace({ id: "cb-p", project_id: "proj-001", alias: "parent", path: "/tmp/p", default_branch: "main" });
    createWorkspace({
      id: "cb-cc",
      project_id: "proj-001",
      alias: "child",
      path: "/tmp/p/child",
      default_branch: "main",
      parent_workspace_id: "cb-p",
      submodule_path: "child",
    });
    const r = await invokeRpcMethod("workspaces.listSubmodules", { id: "cb-p" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const body = r.payload as { submodules: Array<{ alias: string }> };
      expect(body.submodules.map((s) => s.alias)).toEqual(["child"]);
    }
  });
});

