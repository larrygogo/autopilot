import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { _setDbForTest, initDb } from "../src/core/db";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate002 } from "../src/migrations/002-schedules";
import { up as migrate004 } from "../src/migrations/004-repos";
import { up as migrate005 } from "../src/migrations/005-requirements";
import { up as migrate006 } from "../src/migrations/006-submodules";
import { up as migrate007 } from "../src/migrations/007-workflows";
import { up as migrate008 } from "../src/migrations/008-projects";
import {
  createProject, getProjectById, listProjects,
  updateProject, deleteProject, nextProjectId,
} from "../src/core/projects";

describe("projects CRUD", () => {
  let sqlite: Database;

  beforeAll(() => {
    sqlite = new Database(":memory:");
    _setDbForTest(sqlite);
    initDb();
    migrate001(sqlite);
    migrate002(sqlite);
    migrate004(sqlite);
    migrate005(sqlite);
    migrate006(sqlite);
    migrate007(sqlite);
    migrate008(sqlite);
  });

  afterAll(() => {
    _setDbForTest(null);
    sqlite.close();
  });

  it("createProject + getProjectById", () => {
    const p = createProject({ id: "proj-100", name: "ClawMo", description: "desc" });
    expect(p.name).toBe("ClawMo");
    expect(typeof p.created_at).toBe("number");

    const fetched = getProjectById("proj-100");
    expect(fetched?.name).toBe("ClawMo");
    expect(fetched?.description).toBe("desc");
  });

  it("listProjects 按 created_at 升序", () => {
    createProject({ id: "proj-200", name: "A" });
    createProject({ id: "proj-201", name: "B" });
    const list = listProjects();
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list[0].created_at).toBeLessThanOrEqual(list[list.length - 1].created_at);
  });

  it("updateProject 更新 name 和 description", () => {
    createProject({ id: "proj-300", name: "old" });
    const before = getProjectById("proj-300")!;
    const updated = updateProject("proj-300", { name: "new", description: "d" });
    expect(updated?.name).toBe("new");
    expect(updated?.description).toBe("d");
    expect(updated!.updated_at).toBeGreaterThanOrEqual(before.updated_at);
  });

  it("deleteProject 删除", () => {
    createProject({ id: "proj-400", name: "tmp" });
    deleteProject("proj-400");
    expect(getProjectById("proj-400")).toBeNull();
  });

  it("nextProjectId 生成 proj-NNN 格式且递增", () => {
    const id1 = nextProjectId();
    createProject({ id: id1, name: "n" });
    const id2 = nextProjectId();
    expect(id1.startsWith("proj-")).toBe(true);
    expect(id2.startsWith("proj-")).toBe(true);
    expect(id2).not.toBe(id1);
  });
});
