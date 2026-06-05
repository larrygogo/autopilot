/**
 * 新建需求自动绑定工作区 —— 项目:工作区 1:1，创建需求时不再要求用户选工作区，
 * 未显式传 workspace_id 时由 daemon 从项目唯一顶层工作区自动派生。
 * 同时验证：项目无工作区 → PRECONDITION_FAILED；显式传入的 workspace_id 优先生效。
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { _setDbForTest, initDb } from "../src/core/db";
import { runPendingMigrations } from "../src/core/migrate";
import { createProject } from "../src/core/projects";
import { createWorkspace, getTopWorkspaceForProject } from "../src/core/workspaces";
import { invokeRpcMethod } from "../src/daemon/rpc";
import { registerCoreRpcMethods } from "../src/daemon/rpc-methods";

describe("新建需求自动绑定工作区（项目:工作区 1:1）", () => {
  let db: Database;

  beforeAll(async () => {
    db = new Database(":memory:");
    _setDbForTest(db);
    initDb();
    await runPendingMigrations();
    registerCoreRpcMethods();
  });

  afterAll(() => {
    _setDbForTest(null);
    db.close();
  });

  beforeEach(() => {
    db.run("DELETE FROM requirements");
    db.run("DELETE FROM workspaces");
    db.run("DELETE FROM projects");
  });

  it("getTopWorkspaceForProject 返回项目唯一顶层工作区", () => {
    createProject({ id: "proj-1", name: "P1" });
    createWorkspace({ id: "ws-1", project_id: "proj-1", alias: "main", path: "/tmp/p1", default_branch: "main" });
    expect(getTopWorkspaceForProject("proj-1")?.id).toBe("ws-1");
    expect(getTopWorkspaceForProject("proj-none")).toBeNull();
  });

  it("只传 project_id 创建需求 → 自动派生该项目工作区", async () => {
    createProject({ id: "proj-2", name: "P2" });
    createWorkspace({ id: "ws-2", project_id: "proj-2", alias: "main", path: "/tmp/p2", default_branch: "main" });

    const r = await invokeRpcMethod("requirements.create", { project_id: "proj-2", title: "做个功能" });

    expect(r.ok).toBe(true);
    if (r.ok) {
      const { requirement } = r.payload as { requirement: { id: string; workspace_id: string | null; status: string } };
      expect(requirement.workspace_id).toBe("ws-2");
      expect(requirement.status).toBe("clarifying");
    }
  });

  it("项目无工作区 → PRECONDITION_FAILED，不创建", async () => {
    createProject({ id: "proj-3", name: "P3" });

    const r = await invokeRpcMethod("requirements.create", { project_id: "proj-3", title: "x" });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("PRECONDITION_FAILED");
  });

  it("显式传 workspace_id 时优先生效（不被自动派生覆盖）", async () => {
    createProject({ id: "proj-4", name: "P4" });
    createWorkspace({ id: "ws-4a", project_id: "proj-4", alias: "a", path: "/tmp/p4a", default_branch: "main" });

    const r = await invokeRpcMethod("requirements.create", { project_id: "proj-4", workspace_id: "ws-4a", title: "x" });

    expect(r.ok).toBe(true);
    if (r.ok) {
      const { requirement } = r.payload as { requirement: { workspace_id: string | null } };
      expect(requirement.workspace_id).toBe("ws-4a");
    }
  });
});
