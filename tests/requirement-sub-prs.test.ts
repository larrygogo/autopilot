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
import { _setDbForTest } from "../src/core/db";
import { createWorkspace } from "../src/core/workspaces";
import { createProject } from "../src/core/projects";
import { createRequirement, deleteRequirement } from "../src/core/requirements";
import { appendSubPr, listSubPrs } from "../src/core/requirement-sub-prs";

describe("requirement-sub-prs CRUD", () => {
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
    _setDbForTest(db);
    // FK 满足
    createProject({ id: "proj-001", name: "test-proj" });
    createWorkspace({ id: "cb-p", project_id: "proj-001", alias: "p", path: "/tmp/p" });
    createWorkspace({
      id: "cb-c",
      project_id: "proj-001",
      alias: "c",
      path: "/tmp/p/c",
      parent_workspace_id: "cb-p",
      submodule_path: "c",
    });
    createRequirement({
      id: "req-001",
      project_id: "proj-001",
      workspace_id: "cb-p",
      title: "test",
    });
    createRequirement({
      id: "req-002",
      project_id: "proj-001",
      workspace_id: "cb-p",
      title: "test2",
    });
  });

  afterAll(() => {
    _setDbForTest(null);
    db.close();
  });

  beforeEach(() => {
    db.run("DELETE FROM requirement_sub_prs");
  });

  it("appendSubPr + listSubPrs", () => {
    appendSubPr({
      requirement_id: "req-001",
      child_workspace_id: "cb-c",
      pr_url: "https://github.com/x/y/pull/1",
      pr_number: 1,
    });
    const list = listSubPrs("req-001");
    expect(list.length).toBe(1);
    expect(list[0].pr_url).toContain("/pull/1");
    expect(list[0].pr_number).toBe(1);
  });

  it("UPSERT 已存在时更新 pr_url/pr_number", () => {
    appendSubPr({
      requirement_id: "req-001",
      child_workspace_id: "cb-c",
      pr_url: "https://github.com/x/y/pull/1",
      pr_number: 1,
    });
    appendSubPr({
      requirement_id: "req-001",
      child_workspace_id: "cb-c",
      pr_url: "https://github.com/x/y/pull/2",
      pr_number: 2,
    });
    const list = listSubPrs("req-001");
    expect(list.length).toBe(1);
    expect(list[0].pr_number).toBe(2);
  });

  it("不同需求隔离", () => {
    appendSubPr({
      requirement_id: "req-001",
      child_workspace_id: "cb-c",
      pr_url: "https://github.com/x/y/pull/1",
      pr_number: 1,
    });
    appendSubPr({
      requirement_id: "req-002",
      child_workspace_id: "cb-c",
      pr_url: "https://github.com/x/y/pull/2",
      pr_number: 2,
    });
    expect(listSubPrs("req-001").length).toBe(1);
    expect(listSubPrs("req-002").length).toBe(1);
  });

  it("空查询返回空数组", () => {
    expect(listSubPrs("req-no-such")).toEqual([]);
  });

  it("deleteRequirement 级联删 sub_prs", () => {
    appendSubPr({
      requirement_id: "req-001",
      child_workspace_id: "cb-c",
      pr_url: "https://github.com/x/y/pull/1",
      pr_number: 1,
    });
    appendSubPr({
      requirement_id: "req-002",
      child_workspace_id: "cb-c",
      pr_url: "https://github.com/x/y/pull/2",
      pr_number: 2,
    });
    expect(listSubPrs("req-001").length).toBe(1);
    expect(listSubPrs("req-002").length).toBe(1);
    deleteRequirement("req-001");
    expect(listSubPrs("req-001")).toEqual([]);
    expect(listSubPrs("req-002").length).toBe(1);
  });
});
