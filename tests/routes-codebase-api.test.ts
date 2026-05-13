/**
 * /api/codebases 新主路由测试。
 *
 * 旧 /api/repos 路由继续保留作为别名（响应字段 repo/repos），
 * P6 清理；本测试覆盖新主路由的字段名与基础 CRUD。
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

describe("/api/codebases 新主路由", () => {
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
    createProject({ id: "proj-001", name: "P" });
  });

  afterAll(() => {
    _setDbForTest(null);
    db.close();
  });

  beforeEach(() => {
    db.run("DELETE FROM codebases");
  });

  it("GET /api/codebases 返回 { codebases: [...] }", async () => {
    createCodebase({ id: "cb-001", project_id: "proj-001", alias: "x", path: "/tmp/x", default_branch: "main" });
    const res = await handleRequest(new Request("http://localhost/api/codebases"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { codebases: Array<{ id: string; alias: string }> };
    expect(Array.isArray(body.codebases)).toBe(true);
    expect(body.codebases[0]?.id).toBe("cb-001");
    expect(body.codebases[0]?.alias).toBe("x");
  });

  it("POST /api/codebases 返回 { codebase: {...} } + 201", async () => {
    const res = await handleRequest(new Request("http://localhost/api/codebases", {
      method: "POST",
      body: JSON.stringify({ alias: "demo", path: "/tmp/demo", project_id: "proj-001" }),
    }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { codebase: { id: string; alias: string; project_id: string } };
    expect(body.codebase.alias).toBe("demo");
    expect(body.codebase.project_id).toBe("proj-001");
    expect(body.codebase.id).toMatch(/^cb-/);
  });

  it("POST /api/codebases 缺 alias / path → 400", async () => {
    const res = await handleRequest(new Request("http://localhost/api/codebases", {
      method: "POST",
      body: JSON.stringify({ alias: "demo" }),
    }));
    expect(res.status).toBe(400);
  });

  it("GET /api/codebases/:id 返回 { codebase: {...} }", async () => {
    createCodebase({ id: "cb-002", project_id: "proj-001", alias: "y", path: "/tmp/y", default_branch: "main" });
    const res = await handleRequest(new Request("http://localhost/api/codebases/cb-002"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { codebase: { alias: string } };
    expect(body.codebase.alias).toBe("y");
  });

  it("GET /api/codebases/:id 不存在 → 404", async () => {
    const res = await handleRequest(new Request("http://localhost/api/codebases/nope"));
    expect(res.status).toBe(404);
  });

  it("PUT /api/codebases/:id 更新别名", async () => {
    createCodebase({ id: "cb-003", project_id: "proj-001", alias: "old", path: "/tmp/o", default_branch: "main" });
    const res = await handleRequest(new Request("http://localhost/api/codebases/cb-003", {
      method: "PUT",
      body: JSON.stringify({ alias: "new" }),
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { codebase: { alias: string } };
    expect(body.codebase.alias).toBe("new");
  });

  it("DELETE /api/codebases/:id 返回 { ok: true }", async () => {
    createCodebase({ id: "cb-004", project_id: "proj-001", alias: "z", path: "/tmp/z", default_branch: "main" });
    const res = await handleRequest(new Request("http://localhost/api/codebases/cb-004", { method: "DELETE" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(
      (await handleRequest(new Request("http://localhost/api/codebases/cb-004"))).status,
    ).toBe(404);
  });

  it("GET /api/codebases/:id/submodules 返回子模块列表", async () => {
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
    const res = await handleRequest(new Request("http://localhost/api/codebases/cb-p/submodules"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { submodules: Array<{ alias: string }> };
    expect(body.submodules.map((s) => s.alias)).toEqual(["child"]);
  });
});

describe("旧 /api/repos 别名仍工作", () => {
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
    const res = await handleRequest(new Request("http://localhost/api/repos"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repos: Array<{ id: string }> };
    expect(Array.isArray(body.repos)).toBe(true);
    expect(body.repos[0]?.id).toBe("cb-r1");
  });
});
