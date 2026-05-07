import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { setup_req_dev_task } from "../examples/workflows/req_dev/workflow";
import { _setDbForTest, initDb } from "../src/core/db";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate002 } from "../src/migrations/002-schedules";
import { up as migrate004 } from "../src/migrations/004-repos";
import { up as migrate006 } from "../src/migrations/006-submodules";
import { createRepo } from "../src/core/repos";

describe("setup_req_dev_task", () => {
  let sqlite: Database;

  beforeAll(() => {
    sqlite = new Database(":memory:");
    _setDbForTest(sqlite);
    initDb();
    migrate001(sqlite);
    migrate002(sqlite);
    migrate004(sqlite);
    migrate006(sqlite);
    createRepo({
      id: "repo-001",
      alias: "autopilot",
      path: "/tmp/autopilot",
      default_branch: "main",
      github_owner: "larrygogo",
      github_repo: "autopilot",
    });
  });

  afterAll(() => {
    _setDbForTest(null);
    sqlite.close();
  });

  it("根据 repo_id 派生 task 字段", () => {
    const result = setup_req_dev_task({
      repo_id: "repo-001",
      title: "GitHub 集成",
      requirement: "加 GitHub Issues 接入",
    });
    expect(result.title).toBe("GitHub 集成");
    expect(result.repo_id).toBe("repo-001");
    expect(result.repo_path).toBe("/tmp/autopilot");
    expect(result.default_branch).toBe("main");
    expect(result.github_owner).toBe("larrygogo");
    expect(result.github_repo).toBe("autopilot");
    expect(result.requirement).toBe("加 GitHub Issues 接入");
    expect((result.branch as string).startsWith("feat/")).toBe(true);
  });

  it("repo_id 不存在时报错", () => {
    expect(() => setup_req_dev_task({ repo_id: "no-such", title: "x", requirement: "y" }))
      .toThrow(/repo not found/);
  });

  it("title / requirement 缺省", () => {
    const result = setup_req_dev_task({ repo_id: "repo-001" });
    expect(result.title).toBe("untitled");
    expect(result.requirement).toBe("");
  });
});

describe("setup_req_dev_task 注入 submodules（P5.2）", () => {
  let sqlite: Database;

  beforeAll(() => {
    sqlite = new Database(":memory:");
    _setDbForTest(sqlite);
    initDb();
    migrate001(sqlite);
    migrate002(sqlite);
    migrate004(sqlite);
    migrate006(sqlite);
  });

  afterAll(() => {
    _setDbForTest(null);
    sqlite.close();
  });

  it("无子模块时 submodules 为空数组", () => {
    createRepo({ id: "repo-no-sub", alias: "no-sub", path: "/tmp/no-sub" });
    const result = setup_req_dev_task({
      repo_id: "repo-no-sub",
      title: "x",
      requirement: "y",
    });
    expect(result.submodules).toEqual([]);
  });

  it("有子模块时注入数组", () => {
    createRepo({ id: "repo-with-sub", alias: "parent", path: "/tmp/parent" });
    createRepo({
      id: "repo-child",
      alias: "child",
      path: "/tmp/parent/child",
      default_branch: "master",
      github_owner: "foo",
      github_repo: "child",
      parent_repo_id: "repo-with-sub",
      submodule_path: "child",
    });
    const result = setup_req_dev_task({
      repo_id: "repo-with-sub",
      title: "feat",
      requirement: "x",
    });
    const submodules = result.submodules as Array<Record<string, unknown>>;
    expect(submodules.length).toBe(1);
    expect(submodules[0].alias).toBe("child");
    expect(submodules[0].submodule_path).toBe("child");
    expect(submodules[0].default_branch).toBe("master");
    expect(submodules[0].github_owner).toBe("foo");
    expect(submodules[0].github_repo).toBe("child");
    expect(submodules[0].id).toBe("repo-child");
  });
});
