import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import {
  createRepo,
  getRepoById,
  getRepoByAlias,
  listRepos,
  updateRepo,
  deleteRepo,
  nextRepoId,
} from "../src/core/repos";
import { _setDbForTest, initDb } from "../src/core/db";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate002 } from "../src/migrations/002-schedules";
import { up as migrate003 } from "../src/migrations/003-repos";

// 注意：initDb() 不接受路径参数，通过 _setDbForTest 注入内存 DB，
// 再手动执行各迁移脚本，确保 repos 表存在且与迁移定义一致。

describe("repos CRUD", () => {
  let sqlite: Database;

  beforeAll(() => {
    sqlite = new Database(":memory:");
    _setDbForTest(sqlite);
    // 执行基础 PRAGMA 和 tasks/task_logs 表（initDb 内部调用 getDb()，会用注入的实例）
    initDb();
    // 执行所有迁移（001 已包含在 initDb schema 里，002/003 需要额外执行）
    migrate001(sqlite);
    migrate002(sqlite);
    migrate003(sqlite);
  });

  afterAll(() => {
    _setDbForTest(null);
    sqlite.close();
  });

  it("createRepo + getRepoById + getRepoByAlias", () => {
    const created = createRepo({
      id: "repo-001",
      alias: "autopilot",
      path: "/tmp/autopilot",
      default_branch: "main",
      github_owner: "larrygogo",
      github_repo: "autopilot",
    });

    expect(created.alias).toBe("autopilot");
    expect(created.path).toBe("/tmp/autopilot");
    expect(typeof created.created_at).toBe("number");

    const byId = getRepoById("repo-001");
    expect(byId?.alias).toBe("autopilot");
    expect(byId?.path).toBe("/tmp/autopilot");
    expect(typeof byId?.created_at).toBe("number");

    const byAlias = getRepoByAlias("autopilot");
    expect(byAlias?.id).toBe("repo-001");
  });

  it("alias 重复时报错（UNIQUE 约束）", () => {
    expect(() => {
      createRepo({
        id: "repo-002",
        alias: "autopilot",
        path: "/tmp/another",
      });
    }).toThrow();
  });

  it("listRepos 按 created_at 升序", () => {
    const repo3 = createRepo({ id: "repo-003", alias: "alpha", path: "/tmp/a" });
    const repo4 = createRepo({ id: "repo-004", alias: "beta", path: "/tmp/b" });
    expect(repo3.id).toBe("repo-003");
    expect(repo4.id).toBe("repo-004");
    const all = listRepos();
    expect(all.length).toBeGreaterThanOrEqual(3);
    expect(all[0].id).toBe("repo-001");
  });

  it("updateRepo 更新可变字段", () => {
    const before = getRepoById("repo-001");
    const updated = updateRepo("repo-001", { path: "/new/path", default_branch: "develop" });
    expect(updated?.path).toBe("/new/path");
    expect(updated?.default_branch).toBe("develop");
    expect(updated?.updated_at).toBeGreaterThanOrEqual(before?.updated_at ?? 0);
  });

  it("updateRepo 空 opts 是 no-op", () => {
    const before = getRepoById("repo-001");
    const after = updateRepo("repo-001", {});
    expect(after?.path).toBe(before?.path);
    expect(after?.updated_at).toBe(before?.updated_at);
  });

  it("deleteRepo 删除", () => {
    deleteRepo("repo-003");
    expect(getRepoById("repo-003")).toBeNull();
  });

  it("nextRepoId 自增", () => {
    // 已有 repo-001（repo-002 alias 重复写入失败，repo-003 已删除），repo-004 存在
    // nextRepoId 应当返回编号 > 已有最大值（repo-004 → 5）
    const next = nextRepoId();
    expect(next).toMatch(/^repo-\d{3}$/);
    const num = parseInt(next.replace("repo-", ""), 10);
    expect(num).toBeGreaterThanOrEqual(5);
  });
});
