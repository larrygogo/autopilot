import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { up as m001 } from "../src/migrations/001-baseline";
import { up as m002 } from "../src/migrations/002-schedules";
import { up as m004 } from "../src/migrations/004-repos";
import { up as m005 } from "../src/migrations/005-requirements";
import { up as m006 } from "../src/migrations/006-submodules";
import { up as m007 } from "../src/migrations/007-workflows";
import { up as m008 } from "../src/migrations/008-projects";
import { up as m009 } from "../src/migrations/009-nullable-codebase";
import { up as m010 } from "../src/migrations/010-question-suggestions";
import { up as m011 } from "../src/migrations/011-now-dismissed-cards";
import { up as m012 } from "../src/migrations/012-spec-revisions";
import { up as m013 } from "../src/migrations/013-active-question-id";
import { up as m014 } from "../src/migrations/014-resolve-orphan-open-questions";
import { up as m024 } from "../src/migrations/024-codebase-to-workspace";
import { _setDbForTest } from "../src/core/db";
import { createSpecRevision, listSpecRevisionsByRequirement } from "../src/core/spec-revisions";

function initSchema(): void {
  const db = new Database(":memory:");
  [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013, m014, m024].forEach(fn => fn(db));
  _setDbForTest(db);
  db.run("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1', 'P', 0, 0)");
  db.run("INSERT INTO requirements (id, project_id, title, status, spec_md, created_at, updated_at) VALUES ('r1', 'p1', 'T', 'clarifying', '', 0, 0)");
}

describe("spec-revisions", () => {
  beforeEach(() => initSchema());

  it("createSpecRevision 写入一条记录并返回 id", () => {
    const id = createSpecRevision({
      requirement_id: "r1",
      before_md: "v1",
      after_md: "v2",
      summary: "加了 X",
      source: "clarifier",
      triggered_by_question_id: null,
    });
    expect(id).toBeGreaterThan(0);
  });

  it("listSpecRevisionsByRequirement 按 created_at desc 返回", async () => {
    const id1 = createSpecRevision({
      requirement_id: "r1",
      before_md: "v1",
      after_md: "v2",
      summary: "r1",
      source: "clarifier",
      triggered_by_question_id: null,
    });
    await new Promise(r => setTimeout(r, 2));
    const id2 = createSpecRevision({
      requirement_id: "r1",
      before_md: "v2",
      after_md: "v3",
      summary: "r2",
      source: "clarifier",
      triggered_by_question_id: null,
    });

    const list = listSpecRevisionsByRequirement("r1");
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe(id2);
    expect(list[1].id).toBe(id1);
    expect(list[0].summary).toBe("r2");
  });

  it("不同 requirement 的 revision 互相隔离", () => {
    createSpecRevision({
      requirement_id: "r1",
      before_md: "a",
      after_md: "b",
      summary: "r1 only",
      source: "clarifier",
      triggered_by_question_id: null,
    });
    expect(listSpecRevisionsByRequirement("non-existent")).toEqual([]);
  });

  it("source 字段接受 user-edit / system / clarifier", () => {
    createSpecRevision({
      requirement_id: "r1",
      before_md: "",
      after_md: "x",
      summary: null,
      source: "user-edit",
      triggered_by_question_id: null,
    });
    const list = listSpecRevisionsByRequirement("r1");
    expect(list[0].source).toBe("user-edit");
  });
});
