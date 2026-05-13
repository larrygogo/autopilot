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
import { up as m016 } from "../src/migrations/016-requirement-clarifier-override";

describe("migration 016-requirement-clarifier-override", () => {
  it("requirements 表新增两个 nullable 字段", () => {
    const db = new Database(":memory:");
    [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013, m014, m015, m016].forEach(fn => fn(db));
    const cols = db.query<{ name: string; notnull: number }, []>("PRAGMA table_info(requirements)").all();
    const p = cols.find(c => c.name === "clarifier_provider");
    const m = cols.find(c => c.name === "clarifier_model");
    expect(p).toBeDefined();
    expect(p!.notnull).toBe(0);
    expect(m).toBeDefined();
    expect(m!.notnull).toBe(0);
  });

  it("默认 NULL，可写入与清空", () => {
    const db = new Database(":memory:");
    [m001, m002, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013, m014, m015, m016].forEach(fn => fn(db));
    db.run("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1', 'P', 0, 0)");
    db.run("INSERT INTO requirements (id, project_id, title, status, spec_md, created_at, updated_at) VALUES ('r1', 'p1', 'T', 'clarifying', '', 0, 0)");
    let r = db.query<{ clarifier_provider: string | null; clarifier_model: string | null }, []>("SELECT clarifier_provider, clarifier_model FROM requirements WHERE id = 'r1'").get();
    expect(r?.clarifier_provider).toBeNull();
    expect(r?.clarifier_model).toBeNull();

    db.run("UPDATE requirements SET clarifier_provider = ?, clarifier_model = ? WHERE id = 'r1'", ["openai", "gpt-5"]);
    r = db.query<{ clarifier_provider: string | null; clarifier_model: string | null }, []>("SELECT clarifier_provider, clarifier_model FROM requirements WHERE id = 'r1'").get();
    expect(r?.clarifier_provider).toBe("openai");
    expect(r?.clarifier_model).toBe("gpt-5");
  });
});
