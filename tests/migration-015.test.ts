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
import { up as m015 } from "../src/migrations/015-clarifier-error";

describe("migration 015-clarifier-error", () => {
  it("requirements 表新增 clarifier_error 字段，nullable 默认 NULL", () => {
    const db = new Database(":memory:");
    [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013, m014, m015].forEach(fn => fn(db));
    const cols = db.query<{ name: string; notnull: number }, []>(
      "PRAGMA table_info(requirements)"
    ).all();
    const col = cols.find(c => c.name === "clarifier_error");
    expect(col).toBeDefined();
    expect(col!.notnull).toBe(0);
  });

  it("可写入与清空", () => {
    const db = new Database(":memory:");
    [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013, m014, m015].forEach(fn => fn(db));
    db.run("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1', 'P', 0, 0)");
    db.run("INSERT INTO requirements (id, project_id, title, status, spec_md, created_at, updated_at) VALUES ('r1', 'p1', 'T', 'clarifying', '', 0, 0)");

    db.run("UPDATE requirements SET clarifier_error = ? WHERE id = ?", ["AI 调用失败", "r1"]);
    let r = db.query<{ clarifier_error: string | null }, []>("SELECT clarifier_error FROM requirements WHERE id = 'r1'").get();
    expect(r?.clarifier_error).toBe("AI 调用失败");

    db.run("UPDATE requirements SET clarifier_error = NULL WHERE id = ?", ["r1"]);
    r = db.query<{ clarifier_error: string | null }, []>("SELECT clarifier_error FROM requirements WHERE id = 'r1'").get();
    expect(r?.clarifier_error).toBeNull();
  });
});
