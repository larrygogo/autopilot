import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate004 } from "../src/migrations/004-repos";
import { up as migrate005 } from "../src/migrations/005-requirements";
import { up as migrate006 } from "../src/migrations/006-submodules";
import { _setDbForTest } from "../src/core/db";
import { createRepo } from "../src/core/repos";
import { createRequirement, nextRequirementId } from "../src/core/requirements";
import { appendSubPr } from "../src/core/requirement-sub-prs";
import { handleRequest } from "../src/daemon/routes";

describe("submodule + sub-pr 查询 API", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    migrate001(db);
    migrate004(db);
    migrate005(db);
    migrate006(db);
    _setDbForTest(db);

    createRepo({ id: "repo-p1", alias: "parent1", path: "/tmp/p1", default_branch: "main" });
    createRepo({
      id: "repo-c1",
      alias: "child1",
      path: "/tmp/p1/child1",
      default_branch: "main",
      parent_repo_id: "repo-p1",
      submodule_path: "child1",
      github_owner: "owner",
      github_repo: "child1-repo",
    });
    createRepo({
      id: "repo-c2",
      alias: "child2",
      path: "/tmp/p1/child2",
      default_branch: "master",
      parent_repo_id: "repo-p1",
      submodule_path: "child2",
    });
  });

  afterAll(() => {
    _setDbForTest(null);
    db.close();
  });

  beforeEach(() => {
    db.run("DELETE FROM requirement_sub_prs");
    db.run("DELETE FROM requirement_feedbacks");
    db.run("DELETE FROM requirements");
  });

  it("GET /api/repos/:id/submodules 返回父 repo 的所有子模块", async () => {
    const req = new Request("http://localhost/api/repos/repo-p1/submodules");
    const res = await handleRequest(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { submodules: Array<{ id: string; alias: string }> };
    expect(body.submodules.length).toBe(2);
    expect(body.submodules.map((s) => s.alias).sort()).toEqual(["child1", "child2"]);
  });

  it("GET /api/repos/:id/submodules 子模块 id 自身 → 返回空（非父 repo）", async () => {
    const req = new Request("http://localhost/api/repos/repo-c1/submodules");
    const res = await handleRequest(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { submodules: unknown[] };
    expect(body.submodules.length).toBe(0);
  });

  it("GET /api/repos/:id/submodules 不存在的 repo → 404", async () => {
    const req = new Request("http://localhost/api/repos/no-such/submodules");
    const res = await handleRequest(req);
    expect(res.status).toBe(404);
  });

  it("GET /api/requirements/:id/sub-prs 返回该需求的所有子模块 PR", async () => {
    const reqId = nextRequirementId();
    createRequirement({ id: reqId, repo_id: "repo-p1", title: "T" });
    appendSubPr({
      requirement_id: reqId,
      child_repo_id: "repo-c1",
      pr_url: "https://github.com/owner/child1-repo/pull/10",
      pr_number: 10,
    });
    appendSubPr({
      requirement_id: reqId,
      child_repo_id: "repo-c2",
      pr_url: "https://github.com/owner/child2-repo/pull/20",
      pr_number: 20,
    });

    const req = new Request(`http://localhost/api/requirements/${reqId}/sub-prs`);
    const res = await handleRequest(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sub_prs: Array<{ child_repo_id: string; pr_number: number; pr_url: string }>;
    };
    expect(body.sub_prs.length).toBe(2);
    expect(body.sub_prs.map((p) => p.pr_number).sort()).toEqual([10, 20]);
  });

  it("GET /api/requirements/:id/sub-prs 不存在的 req → 404", async () => {
    const req = new Request("http://localhost/api/requirements/no-such-req/sub-prs");
    const res = await handleRequest(req);
    expect(res.status).toBe(404);
  });
});
