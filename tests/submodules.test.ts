import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate004 } from "../src/migrations/004-repos";
import { up as migrate005 } from "../src/migrations/005-requirements";
import { up as migrate006 } from "../src/migrations/006-submodules";
import { _setDbForTest } from "../src/core/db";
import { createRepo } from "../src/core/repos";
import { discoverSubmodules, listSubmodules } from "../src/core/submodules";

describe("migration 006-submodules", () => {
  it("repos 表加 parent_repo_id + submodule_path 字段", () => {
    const db = new Database(":memory:");
    migrate004(db);
    migrate006(db);

    const cols = db.query<{ name: string }, []>("PRAGMA table_info(repos)").all();
    const names = cols.map(c => c.name).sort();
    expect(names).toContain("parent_repo_id");
    expect(names).toContain("submodule_path");
  });

  it("创建 requirement_sub_prs 表", () => {
    const db = new Database(":memory:");
    migrate004(db);
    migrate005(db);
    migrate006(db);

    const cols = db.query<{ name: string }, []>("PRAGMA table_info(requirement_sub_prs)").all();
    const names = cols.map(c => c.name).sort();
    expect(names).toEqual([
      "child_repo_id",
      "created_at",
      "id",
      "pr_number",
      "pr_url",
      "requirement_id",
    ]);
  });

  it("requirement_sub_prs UNIQUE(requirement_id, child_repo_id)", () => {
    const db = new Database(":memory:");
    migrate004(db);
    migrate005(db);
    migrate006(db);
    db.exec("PRAGMA foreign_keys = OFF;");

    db.run(
      "INSERT INTO requirement_sub_prs (requirement_id, child_repo_id, pr_url, pr_number, created_at) VALUES (?,?,?,?,?)",
      ["req-001", "repo-002", "https://github.com/x/y/pull/1", 1, 1]
    );
    expect(() => {
      db.run(
        "INSERT INTO requirement_sub_prs (requirement_id, child_repo_id, pr_url, pr_number, created_at) VALUES (?,?,?,?,?)",
        ["req-001", "repo-002", "https://github.com/x/y/pull/2", 2, 2]
      );
    }).toThrow(/UNIQUE/i);
  });
});

describe("discoverSubmodules", () => {
  let testDb: Database;
  let parentDir: string;

  beforeAll(() => {
    testDb = new Database(":memory:");
    migrate001(testDb);
    migrate004(testDb);
    migrate006(testDb);
    _setDbForTest(testDb);
  });

  afterAll(() => {
    _setDbForTest(null);
    testDb.close();
    if (parentDir) {
      try { rmSync(parentDir, { recursive: true, force: true }); } catch (e: unknown) {}
    }
  });

  beforeEach(() => {
    testDb.run("DELETE FROM repos");
    parentDir = join(tmpdir(), `discover-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(parentDir, { recursive: true });
  });

  it("无 .gitmodules → added=0 existing=0", () => {
    createRepo({ id: "repo-p", alias: "parent", path: parentDir });
    const r = discoverSubmodules("repo-p");
    expect(r.added.length).toBe(0);
    expect(r.existing.length).toBe(0);
  });

  it("发现并注册一个 GitHub 子模块", () => {
    writeFileSync(
      join(parentDir, ".gitmodules"),
      `[submodule "child"]
\tpath = child
\turl = https://github.com/foo/child.git
\tbranch = master
`,
    );
    mkdirSync(join(parentDir, "child"), { recursive: true });

    createRepo({ id: "repo-p", alias: "parent", path: parentDir });
    const r = discoverSubmodules("repo-p");

    expect(r.added.length).toBe(1);
    const child = r.added[0];
    expect(child.alias).toBe("child");
    expect(child.parent_repo_id).toBe("repo-p");
    expect(child.submodule_path).toBe("child");
    expect(child.default_branch).toBe("master");
    expect(child.github_owner).toBe("foo");
    expect(child.github_repo).toBe("child");
  });

  it("第二次调用 → existing=1 added=0（幂等）", () => {
    writeFileSync(
      join(parentDir, ".gitmodules"),
      `[submodule "x"]\n\tpath = x\n\turl = https://github.com/o/x.git\n`,
    );
    mkdirSync(join(parentDir, "x"), { recursive: true });
    createRepo({ id: "repo-p", alias: "parent", path: parentDir });
    discoverSubmodules("repo-p");
    const r = discoverSubmodules("repo-p");
    expect(r.added.length).toBe(0);
    expect(r.existing.length).toBe(1);
  });

  it("非 GitHub url 跳过 + warning", () => {
    writeFileSync(
      join(parentDir, ".gitmodules"),
      `[submodule "lab"]\n\tpath = lab\n\turl = https://gitlab.com/o/lab.git\n`,
    );
    mkdirSync(join(parentDir, "lab"), { recursive: true });
    createRepo({ id: "repo-p", alias: "parent", path: parentDir });
    const r = discoverSubmodules("repo-p");
    expect(r.added.length).toBe(0);
    expect(r.warnings.some(w => w.includes("不是 GitHub"))).toBe(true);
  });

  it("子模块路径不存在 → 跳过 + warning", () => {
    writeFileSync(
      join(parentDir, ".gitmodules"),
      `[submodule "ghost"]\n\tpath = ghost\n\turl = https://github.com/o/ghost.git\n`,
    );
    // 不创建 ghost 目录
    createRepo({ id: "repo-p", alias: "parent", path: parentDir });
    const r = discoverSubmodules("repo-p");
    expect(r.added.length).toBe(0);
    expect(r.warnings.some(w => w.includes("不存在或不是目录"))).toBe(true);
  });

  it("alias 冲突自动加后缀", () => {
    createRepo({ id: "repo-existing", alias: "child", path: "/tmp/something-else" });
    writeFileSync(
      join(parentDir, ".gitmodules"),
      `[submodule "child"]\n\tpath = child\n\turl = https://github.com/foo/child.git\n`,
    );
    mkdirSync(join(parentDir, "child"), { recursive: true });
    createRepo({ id: "repo-p", alias: "parent", path: parentDir });
    const r = discoverSubmodules("repo-p");
    expect(r.added.length).toBe(1);
    expect(r.added[0].alias).toBe("child-2");
  });

  it("listSubmodules 返回某父的所有子", () => {
    createRepo({ id: "repo-p", alias: "p", path: parentDir });
    createRepo({
      id: "repo-c1",
      alias: "c1",
      path: "/tmp/c1",
      parent_repo_id: "repo-p",
      submodule_path: "c1",
    });
    createRepo({
      id: "repo-c2",
      alias: "c2",
      path: "/tmp/c2",
      parent_repo_id: "repo-p",
      submodule_path: "c2",
    });
    expect(listSubmodules("repo-p").length).toBe(2);
    expect(listSubmodules("nonexistent").length).toBe(0);
  });

  it("拒绝在子模块上调 discoverSubmodules（嵌套）", () => {
    createRepo({ id: "repo-p", alias: "p", path: parentDir });
    createRepo({
      id: "repo-c",
      alias: "c",
      path: "/tmp/c",
      parent_repo_id: "repo-p",
      submodule_path: "c",
    });
    expect(() => discoverSubmodules("repo-c")).toThrow(/不支持嵌套/);
  });
});
