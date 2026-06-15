import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate004 } from "../src/migrations/004-repos";
import { up as migrate005 } from "../src/migrations/005-requirements";
import { up as migrate006 } from "../src/migrations/006-submodules";
import { up as migrate007 } from "../src/migrations/007-workflows";
import { up as migrate008 } from "../src/migrations/008-projects";
import { up as migrate021 } from "../src/migrations/021-requirement-comments";
import { up as migrate024 } from "../src/migrations/024-codebase-to-workspace";
import { up as migrate033 } from "../src/migrations/033-workspace-remote-url";
import { _setDbForTest } from "../src/core/db";
import { createWorkspace } from "../src/core/workspaces";
import { createProject } from "../src/core/projects";
import { createRequirement, nextRequirementId } from "../src/core/requirements";
import { appendSubPr } from "../src/core/requirements/sub-prs";
import { invokeRpcMethod } from "../src/daemon/rpc";
import { registerCoreRpcMethods } from "../src/daemon/rpc-methods";

describe("submodule + sub-pr 查询 RPC", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    migrate001(db);
    migrate004(db);
    migrate005(db);
    migrate006(db);
    migrate007(db);
    migrate008(db);
    migrate021(db);
    migrate024(db);
    migrate033(db);
    _setDbForTest(db);
    registerCoreRpcMethods();

    createProject({ id: "proj-001", name: "test-proj" });
    createWorkspace({ id: "cb-p1", project_id: "proj-001", alias: "parent1", path: "/tmp/p1", default_branch: "main" });
    createWorkspace({
      id: "cb-c1",
      project_id: "proj-001",
      alias: "child1",
      path: "/tmp/p1/child1",
      default_branch: "main",
      parent_workspace_id: "cb-p1",
      submodule_path: "child1",
      github_owner: "owner",
      github_repo: "child1-repo",
    });
    createWorkspace({
      id: "cb-c2",
      project_id: "proj-001",
      alias: "child2",
      path: "/tmp/p1/child2",
      default_branch: "master",
      parent_workspace_id: "cb-p1",
      submodule_path: "child2",
    });
  });

  afterAll(() => {
    _setDbForTest(null);
    db.close();
  });

  beforeEach(() => {
    db.run("DELETE FROM requirement_sub_prs");
    db.run("DELETE FROM requirement_comments WHERE kind = 'feedback'");
    db.run("DELETE FROM requirements");
  });

  it("workspaces.listSubmodules 返回父 codebase 的所有子模块", async () => {
    const r = await invokeRpcMethod("workspaces.listSubmodules", { id: "cb-p1" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const body = r.payload as { submodules: Array<{ id: string; alias: string }> };
      expect(body.submodules.length).toBe(2);
      expect(body.submodules.map((s) => s.alias).sort()).toEqual(["child1", "child2"]);
    }
  });

  it("workspaces.listSubmodules 子模块 id 自身 → 返回空（非父 codebase）", async () => {
    const r = await invokeRpcMethod("workspaces.listSubmodules", { id: "cb-c1" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const body = r.payload as { submodules: unknown[] };
      expect(body.submodules.length).toBe(0);
    }
  });

  it("workspaces.listSubmodules 不存在的 codebase → NOT_FOUND", async () => {
    const r = await invokeRpcMethod("workspaces.listSubmodules", { id: "no-such" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("NOT_FOUND");
  });

  it("requirements.subPrs 返回该需求的所有子模块 PR", async () => {
    const reqId = nextRequirementId();
    createRequirement({ id: reqId, project_id: "proj-001", workspace_id: "cb-p1", title: "T" });
    appendSubPr({
      requirement_id: reqId,
      child_workspace_id: "cb-c1",
      pr_url: "https://github.com/owner/child1-repo/pull/10",
      pr_number: 10,
    });
    appendSubPr({
      requirement_id: reqId,
      child_workspace_id: "cb-c2",
      pr_url: "https://github.com/owner/child2-repo/pull/20",
      pr_number: 20,
    });

    const r = await invokeRpcMethod("requirements.subPrs", { id: reqId });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const body = r.payload as {
        sub_prs: Array<{ child_workspace_id: string; pr_number: number; pr_url: string }>;
      };
      expect(body.sub_prs.length).toBe(2);
      expect(body.sub_prs.map((p) => p.pr_number).sort()).toEqual([10, 20]);
    }
  });

  it("requirements.subPrs 不存在的 req → NOT_FOUND", async () => {
    const r = await invokeRpcMethod("requirements.subPrs", { id: "no-such-req" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("NOT_FOUND");
  });
});
