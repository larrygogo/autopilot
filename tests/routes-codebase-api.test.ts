/**
 * codebases.* RPC method 测试。
 *
 * 旧 /api/repos HTTP 别名继续保留（响应字段 repo/repos），P6 清理；
 * 本测试只覆盖 codebases.* WS RPC + /api/repos 别名留一个 smoke。
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate004 } from "../src/migrations/004-repos";
import { up as migrate005 } from "../src/migrations/005-requirements";
import { up as migrate006 } from "../src/migrations/006-submodules";
import { up as migrate007 } from "../src/migrations/007-workflows";
import { up as migrate008 } from "../src/migrations/008-projects";
import { _setDbForTest } from "../src/core/db";
import { createCodebase } from "../src/core/codebases";
import { createProject } from "../src/core/projects";
import { handleRequest } from "../src/daemon/routes";
import { invokeRpcMethod } from "../src/daemon/rpc";
import { registerCoreRpcMethods } from "../src/daemon/rpc-methods";

describe("codebases.* RPC", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    migrate001(db);
    migrate004(db);
    migrate005(db);
    migrate006(db);
    migrate007(db);
    migrate008(db);
    _setDbForTest(db);
    registerCoreRpcMethods();
    createProject({ id: "proj-001", name: "P" });
  });

  afterAll(() => {
    _setDbForTest(null);
    db.close();
  });

  beforeEach(() => {
    db.run("DELETE FROM codebases");
  });

  it("codebases.list 返回数组", async () => {
    createCodebase({ id: "cb-001", project_id: "proj-001", alias: "x", path: "/tmp/x", default_branch: "main" });
    const r = await invokeRpcMethod("codebases.list", {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      const list = r.payload as Array<{ id: string; alias: string }>;
      expect(Array.isArray(list)).toBe(true);
      expect(list[0]?.id).toBe("cb-001");
      expect(list[0]?.alias).toBe("x");
    }
  });

  it("codebases.create 返回裸 codebase", async () => {
    const r = await invokeRpcMethod("codebases.create", {
      alias: "demo",
      path: "/tmp/demo",
      project_id: "proj-001",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const cb = r.payload as { id: string; alias: string; project_id: string };
      expect(cb.alias).toBe("demo");
      expect(cb.project_id).toBe("proj-001");
      expect(cb.id).toMatch(/^cb-/);
    }
  });

  it("codebases.create 缺 alias/path → INVALID_PARAM", async () => {
    const r = await invokeRpcMethod("codebases.create", { alias: "demo" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_PARAM");
  });

  it("codebases.get 返回单条", async () => {
    createCodebase({ id: "cb-002", project_id: "proj-001", alias: "y", path: "/tmp/y", default_branch: "main" });
    const r = await invokeRpcMethod("codebases.get", { id: "cb-002" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const cb = r.payload as { alias: string };
      expect(cb.alias).toBe("y");
    }
  });

  it("codebases.get 不存在 → NOT_FOUND", async () => {
    const r = await invokeRpcMethod("codebases.get", { id: "nope" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("NOT_FOUND");
  });

  it("codebases.update 修改别名", async () => {
    createCodebase({ id: "cb-003", project_id: "proj-001", alias: "old", path: "/tmp/o", default_branch: "main" });
    const r = await invokeRpcMethod("codebases.update", { id: "cb-003", alias: "new" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const cb = r.payload as { alias: string };
      expect(cb.alias).toBe("new");
    }
  });

  it("codebases.delete 返回 { ok: true } 且后续 get → NOT_FOUND", async () => {
    createCodebase({ id: "cb-004", project_id: "proj-001", alias: "z", path: "/tmp/z", default_branch: "main" });
    const r = await invokeRpcMethod("codebases.delete", { id: "cb-004" });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.payload as { ok: boolean }).ok).toBe(true);
    const g = await invokeRpcMethod("codebases.get", { id: "cb-004" });
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.error.code).toBe("NOT_FOUND");
  });

  it("codebases.listSubmodules 返回 { submodules: [...] }", async () => {
    createCodebase({ id: "cb-p", project_id: "proj-001", alias: "parent", path: "/tmp/p", default_branch: "main" });
    createCodebase({
      id: "cb-cc",
      project_id: "proj-001",
      alias: "child",
      path: "/tmp/p/child",
      default_branch: "main",
      parent_codebase_id: "cb-p",
      submodule_path: "child",
    });
    const r = await invokeRpcMethod("codebases.listSubmodules", { id: "cb-p" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const body = r.payload as { submodules: Array<{ alias: string }> };
      expect(body.submodules.map((s) => s.alias)).toEqual(["child"]);
    }
  });
});

describe("旧 /api/repos HTTP 别名 smoke", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    migrate001(db);
    migrate004(db);
    migrate005(db);
    migrate006(db);
    migrate007(db);
    migrate008(db);
    _setDbForTest(db);
    createProject({ id: "proj-r", name: "R" });
    createCodebase({ id: "cb-r1", project_id: "proj-r", alias: "r1", path: "/tmp/r1", default_branch: "main" });
  });

  afterAll(() => {
    _setDbForTest(null);
    db.close();
  });

  it("GET /api/repos 仍返回旧字段名 { repos: [...] }", async () => {
    // 模拟 loopback 来源让 checkAuth 豁免 token；测试场景下 daemon 可能已设 token
    const fakeServer = {
      requestIP: () => ({ address: "127.0.0.1", port: 0, family: "IPv4" }),
    } as unknown as import("bun").Server<undefined>;
    const res = await handleRequest(new Request("http://localhost/api/repos"), fakeServer);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repos: Array<{ id: string }> };
    expect(Array.isArray(body.repos)).toBe(true);
    expect(body.repos[0]?.id).toBe("cb-r1");
  });
});
