import { describe, it, expect } from "bun:test";
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

describe("migration 013-active-question-id", () => {
  it("requirements 表新增 active_question_id 字段，nullable", () => {
    const db = new Database(":memory:");
    [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013].forEach(fn => fn(db));

    const cols = db.query<{ name: string; notnull: number }, []>(
      "PRAGMA table_info(requirements)"
    ).all();
    const active = cols.find(c => c.name === "active_question_id");
    expect(active).toBeDefined();
    expect(active!.notnull).toBe(0);
  });

  it("新建 requirement 默认 active_question_id = NULL", () => {
    const db = new Database(":memory:");
    [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013].forEach(fn => fn(db));
    db.run("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1', 'P', 0, 0)");
    db.run("INSERT INTO requirements (id, project_id, title, status, spec_md, created_at, updated_at) VALUES ('r1', 'p1', 'T', 'drafting', '', 0, 0)");
    const r = db.query<{ active_question_id: string | null }, []>("SELECT active_question_id FROM requirements WHERE id = 'r1'").get();
    expect(r?.active_question_id).toBeNull();
  });

  it("可写入指向 question 的 id", () => {
    const db = new Database(":memory:");
    [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013].forEach(fn => fn(db));
    db.run("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1', 'P', 0, 0)");
    db.run("INSERT INTO requirements (id, project_id, title, status, spec_md, created_at, updated_at) VALUES ('r1', 'p1', 'T', 'clarifying', '', 0, 0)");
    db.run("INSERT INTO requirement_questions (id, requirement_id, agent_text, suggestions, status, created_at) VALUES ('q1', 'r1', '?', '[]', 'open', 0)");
    db.run("UPDATE requirements SET active_question_id = 'q1' WHERE id = 'r1'");
    const r = db.query<{ active_question_id: string | null }, []>("SELECT active_question_id FROM requirements WHERE id = 'r1'").get();
    expect(r?.active_question_id).toBe("q1");
  });
});
