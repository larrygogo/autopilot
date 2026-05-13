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
import { up as m014 } from "../src/migrations/014-resolve-orphan-open-questions";

describe("migration 014-resolve-orphan-open-questions", () => {
  it("把 clarifying 需求下的 open question 全标 resolved", () => {
    const db = new Database(":memory:");
    [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013].forEach(fn => fn(db));
    db.run("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1', 'P', 0, 0)");
    db.run("INSERT INTO requirements (id, project_id, title, status, spec_md, created_at, updated_at) VALUES ('r1', 'p1', 'T', 'clarifying', '', 0, 0)");
    db.run("INSERT INTO requirement_questions (id, requirement_id, agent_text, suggestions, status, created_at) VALUES ('q1', 'r1', '?', '[]', 'open', 0)");
    db.run("INSERT INTO requirement_questions (id, requirement_id, agent_text, suggestions, status, created_at) VALUES ('q2', 'r1', '?', '[]', 'open', 0)");

    m014(db);

    const rows = db.query<{ status: string; resolved_at: number | null }, []>(
      "SELECT status, resolved_at FROM requirement_questions WHERE requirement_id = 'r1'"
    ).all();
    expect(rows.every(r => r.status === "resolved")).toBe(true);
    expect(rows.every(r => r.resolved_at !== null)).toBe(true);
  });

  it("不影响非 clarifying 状态需求的 open question", () => {
    const db = new Database(":memory:");
    [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013].forEach(fn => fn(db));
    db.run("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1', 'P', 0, 0)");
    db.run("INSERT INTO requirements (id, project_id, title, status, spec_md, created_at, updated_at) VALUES ('r2', 'p1', 'T', 'drafting', '', 0, 0)");
    db.run("INSERT INTO requirement_questions (id, requirement_id, agent_text, suggestions, status, created_at) VALUES ('q3', 'r2', '?', '[]', 'open', 0)");

    m014(db);

    const r = db.query<{ status: string }, []>("SELECT status FROM requirement_questions WHERE id = 'q3'").get();
    expect(r?.status).toBe("open");
  });

  it("不动已 resolved 的 question", () => {
    const db = new Database(":memory:");
    [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013].forEach(fn => fn(db));
    db.run("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1', 'P', 0, 0)");
    db.run("INSERT INTO requirements (id, project_id, title, status, spec_md, created_at, updated_at) VALUES ('r3', 'p1', 'T', 'clarifying', '', 0, 0)");
    db.run("INSERT INTO requirement_questions (id, requirement_id, agent_text, suggestions, status, resolved_at, created_at) VALUES ('q4', 'r3', '?', '[]', 'resolved', 999, 0)");

    m014(db);

    const r = db.query<{ status: string; resolved_at: number | null }, []>("SELECT status, resolved_at FROM requirement_questions WHERE id = 'q4'").get();
    expect(r?.status).toBe("resolved");
    expect(r?.resolved_at).toBe(999);
  });
});
