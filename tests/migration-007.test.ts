import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate007 } from "../src/migrations/007-workflows";

describe("migration 007-workflows", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    migrate001(db);
    migrate007(db);
  });

  afterAll(() => db.close());

  it("workflows 表存在且字段完整", () => {
    const cols = db.query<{ name: string; type: string; notnull: number }, []>(
      "PRAGMA table_info(workflows)"
    ).all();
    const names = cols.map((c) => c.name);
    expect(names).toContain("name");
    expect(names).toContain("description");
    expect(names).toContain("yaml_content");
    expect(names).toContain("source");
    expect(names).toContain("derives_from");
    expect(names).toContain("file_path");
    expect(names).toContain("created_at");
    expect(names).toContain("updated_at");
  });

  it("source CHECK 约束：source=file 必须有 file_path 不能有 derives_from", () => {
    const ts = Date.now();
    db.run(
      "INSERT INTO workflows (name, description, yaml_content, source, file_path, created_at, updated_at) VALUES (?, ?, ?, 'file', ?, ?, ?)",
      ["wf_a", "", "name: wf_a\nphases: []\n", "/tmp/wf_a", ts, ts]
    );
    expect(() =>
      db.run(
        "INSERT INTO workflows (name, description, yaml_content, source, derives_from, file_path, created_at, updated_at) VALUES (?, ?, ?, 'file', ?, ?, ?, ?)",
        ["wf_bad1", "", "x", "req_dev", "/tmp/wf_bad1", ts, ts]
      )
    ).toThrow();
    expect(() =>
      db.run(
        "INSERT INTO workflows (name, description, yaml_content, source, created_at, updated_at) VALUES (?, ?, ?, 'file', ?, ?)",
        ["wf_bad2", "", "x", ts, ts]
      )
    ).toThrow();
  });

  it("source CHECK 约束：source=db 必须有 derives_from 不能有 file_path", () => {
    const ts = Date.now();
    db.run(
      "INSERT INTO workflows (name, description, yaml_content, source, derives_from, created_at, updated_at) VALUES (?, ?, ?, 'db', ?, ?, ?)",
      ["wf_b", "", "name: wf_b\nphases: []\n", "wf_a", ts, ts]
    );
    expect(() =>
      db.run(
        "INSERT INTO workflows (name, description, yaml_content, source, created_at, updated_at) VALUES (?, ?, ?, 'db', ?, ?)",
        ["wf_bad3", "", "x", ts, ts]
      )
    ).toThrow();
    expect(() =>
      db.run(
        "INSERT INTO workflows (name, description, yaml_content, source, derives_from, file_path, created_at, updated_at) VALUES (?, ?, ?, 'db', ?, ?, ?, ?)",
        ["wf_bad4", "", "x", "wf_a", "/tmp/x", ts, ts]
      )
    ).toThrow();
  });

  it("source 列只允许 'db' 或 'file'", () => {
    const ts = Date.now();
    expect(() =>
      db.run(
        "INSERT INTO workflows (name, description, yaml_content, source, file_path, created_at, updated_at) VALUES (?, ?, ?, 'other', ?, ?, ?)",
        ["wf_bad5", "", "x", "/tmp/x", ts, ts]
      )
    ).toThrow();
  });

  it("name 是主键", () => {
    const ts = Date.now();
    expect(() =>
      db.run(
        "INSERT INTO workflows (name, description, yaml_content, source, file_path, created_at, updated_at) VALUES (?, ?, ?, 'file', ?, ?, ?)",
        ["wf_a", "", "x", "/tmp/wf_a2", ts, ts]
      )
    ).toThrow();
  });

  it("idx_workflows_source 索引存在", () => {
    const idx = db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_workflows_source'"
    ).all();
    expect(idx.length).toBe(1);
  });
});
