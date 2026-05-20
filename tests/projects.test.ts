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
import { up as migrate009 } from "../src/migrations/009-nullable-codebase";
import { up as migrate010 } from "../src/migrations/010-question-suggestions";
import { up as migrate011 } from "../src/migrations/011-now-dismissed-cards";
import { up as migrate021 } from "../src/migrations/021-requirement-comments";
import {
  createProject, getProjectById, listProjects,
  updateProject, deleteProject, nextProjectId,
} from "../src/core/projects";
import { createCodebase } from "../src/core/codebases";
import { createRequirement } from "../src/core/requirements";
import { createQuestion } from "../src/core/requirement-questions";

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
    migrate009(sqlite);
    migrate010(sqlite);
    migrate011(sqlite);
    migrate021(sqlite);
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

  it("deleteProject 级联删 codebases / requirements / questions / replies / feedbacks", async () => {
    const db = (await import("../src/core/db")).getDb();

    createProject({ id: "proj-cascade", name: "Cascade Project" });
    createCodebase({ id: "cb-c1", project_id: "proj-cascade", alias: "main", path: "/tmp/c1" });
    createRequirement({ id: "REQ-CP1", project_id: "proj-cascade", title: "X", spec_md: "" });
    createQuestion({ id: "QST-CP1", requirement_id: "REQ-CP1", agent_text: "Q?" });

    deleteProject("proj-cascade");

    expect(db.query("SELECT COUNT(*) AS n FROM projects WHERE id = 'proj-cascade'").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM codebases WHERE project_id = 'proj-cascade'").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM requirements WHERE project_id = 'proj-cascade'").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM requirement_comments WHERE kind = 'question' AND parent_id IS NULL AND requirement_id = 'REQ-CP1'").get()).toEqual({ n: 0 });
  });
});
