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

describe("migration 012-spec-revisions", () => {
  it("创建 spec_revisions 表，含全部字段与索引", () => {
    const db = new Database(":memory:");
    [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011, m012].forEach(fn => fn(db));

    const cols = db.query<{ name: string; notnull: number }, []>(
      "PRAGMA table_info(spec_revisions)"
    ).all();
    const byName = Object.fromEntries(cols.map(c => [c.name, c]));

    expect(byName["id"]).toBeDefined();
    expect(byName["requirement_id"]).toBeDefined();
    expect(byName["requirement_id"].notnull).toBe(1);
    expect(byName["before_md"]).toBeDefined();
    expect(byName["after_md"]).toBeDefined();
    expect(byName["summary"]).toBeDefined();
    expect(byName["source"]).toBeDefined();
    expect(byName["source"].notnull).toBe(1);
    expect(byName["triggered_by_question_id"]).toBeDefined();
    expect(byName["created_at"]).toBeDefined();

    const idx = db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='spec_revisions'"
    ).all().map(r => r.name);
    expect(idx).toContain("idx_spec_revisions_req");
  });

  it("插入与查询往返", () => {
    const db = new Database(":memory:");
    [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011, m012].forEach(fn => fn(db));
    db.run("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1', 'P', 0, 0)");
    db.run("INSERT INTO requirements (id, project_id, title, status, spec_md, created_at, updated_at) VALUES ('r1', 'p1', 'T', 'clarifying', '', 0, 0)");
    db.run(
      "INSERT INTO spec_revisions (requirement_id, before_md, after_md, summary, source, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["r1", "old", "new", "加了 X", "clarifier", 1700000000000],
    );
    const row = db.query<{ id: number; requirement_id: string; before_md: string; after_md: string; source: string }, []>(
      "SELECT id, requirement_id, before_md, after_md, source FROM spec_revisions WHERE requirement_id = 'r1'"
    ).get();
    expect(row?.before_md).toBe("old");
    expect(row?.after_md).toBe("new");
    expect(row?.source).toBe("clarifier");
  });
});
