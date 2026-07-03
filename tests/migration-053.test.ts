import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate007 } from "../src/migrations/007-workflows";
import { up as migrate048 } from "../src/migrations/048-workflow-kind-spec-json";
import { up as migrate053 } from "../src/migrations/053-drop-yaml-content";

/**
 * migration 053-drop-yaml-content 测试：
 *   ① derived 行 yaml_content → spec_json 回填成功
 *   ② derived 行 yaml 解析失败时保留 NULL spec_json（不丢数据）
 *   ③ yaml_content 列确实删除
 *   ④ 重跑幂等（no-op，不抛错）
 */
describe("migration 053-drop-yaml-content", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys=OFF");
    migrate001(db);
    migrate007(db);
    migrate048(db);
    // 种测试数据：native + derived(可解析 yaml) + derived(坏 yaml)
    const ts = Date.now();
    // native 工作流（有 spec_json，yaml_content 为占位）
    db.run(
      "INSERT INTO workflows (name, description, yaml_content, spec_json, source, kind, created_at, updated_at) VALUES (?, ?, ?, ?, 'db', 'native', ?, ?)",
      ["native_wf", "native 工作流", '{"name":"native_wf","phases":[]}', '{"name":"native_wf","phases":[]}', ts, ts]
    );
    // derived 工作流（spec_json 为 NULL，有 yaml_content 可解析）
    db.run(
      "INSERT INTO workflows (name, description, yaml_content, spec_json, source, kind, derives_from, created_at, updated_at) VALUES (?, ?, ?, ?, 'db', 'derived', 'native_wf', ?, ?)",
      ["derived_good", "可解析 yaml", "name: derived_good\nphases:\n  - name: step1\n", null, ts, ts]
    );
    // derived 工作流（spec_json 为 NULL，yaml_content 坏——无法 yaml.parse）
    db.run(
      "INSERT INTO workflows (name, description, yaml_content, spec_json, source, kind, derives_from, created_at, updated_at) VALUES (?, ?, ?, ?, 'db', 'derived', 'native_wf', ?, ?)",
      ["derived_bad_yaml", "坏 yaml", ": : broken yaml :::\n  - indent: wrong", null, ts, ts]
    );
    // derived 工作流（spec_json 已有内容，不应被覆盖）
    db.run(
      "INSERT INTO workflows (name, description, yaml_content, spec_json, source, kind, derives_from, created_at, updated_at) VALUES (?, ?, ?, ?, 'db', 'derived', 'native_wf', ?, ?)",
      ["derived_already", "spec_json 已有", "name: derived_already\nphases: []\n", '{"name":"derived_already","phases":[]}', ts, ts]
    );
    // 跑迁移
    migrate053(db);
  });

  afterAll(() => db.close());

  it("yaml_content 列已删除", () => {
    const cols = db
      .query<{ name: string }, []>("PRAGMA table_info(workflows)")
      .all()
      .map((r) => r.name);
    expect(cols).not.toContain("yaml_content");
  });

  it("derived 行（可解析 yaml）回填 spec_json 成功", () => {
    const row = db
      .query<{ spec_json: string | null }, [string]>(
        "SELECT spec_json FROM workflows WHERE name = ?"
      )
      .get("derived_good");
    expect(row).not.toBeNull();
    expect(row!.spec_json).not.toBeNull();
    // 回填的 spec_json 可 JSON 解析，含 phases
    const parsed = JSON.parse(row!.spec_json!) as Record<string, unknown>;
    expect(Array.isArray(parsed.phases)).toBe(true);
  });

  it("derived 行（坏 yaml）保留 NULL spec_json（不丢数据）", () => {
    const row = db
      .query<{ spec_json: string | null }, [string]>(
        "SELECT spec_json FROM workflows WHERE name = ?"
      )
      .get("derived_bad_yaml");
    expect(row).not.toBeNull();
    // 解析失败应保留 NULL（不删行）
    expect(row!.spec_json).toBeNull();
  });

  it("derived 行（spec_json 已有）不被覆盖", () => {
    const row = db
      .query<{ spec_json: string | null }, [string]>(
        "SELECT spec_json FROM workflows WHERE name = ?"
      )
      .get("derived_already");
    expect(row).not.toBeNull();
    expect(row!.spec_json).toBe('{"name":"derived_already","phases":[]}');
  });

  it("native 行 spec_json 不受影响", () => {
    const row = db
      .query<{ spec_json: string | null }, [string]>(
        "SELECT spec_json FROM workflows WHERE name = ?"
      )
      .get("native_wf");
    expect(row).not.toBeNull();
    expect(row!.spec_json).toBe('{"name":"native_wf","phases":[]}');
  });

  it("重跑迁移 no-op（幂等：yaml_content 列已不在，跳过）", () => {
    // 重跑不应抛错
    expect(() => migrate053(db)).not.toThrow();
    // 列仍不在
    const cols = db
      .query<{ name: string }, []>("PRAGMA table_info(workflows)")
      .all()
      .map((r) => r.name);
    expect(cols).not.toContain("yaml_content");
  });

  it("其他 schema 字段保留完整", () => {
    const cols = db
      .query<{ name: string }, []>("PRAGMA table_info(workflows)")
      .all()
      .map((r) => r.name);
    for (const expected of ["name", "description", "spec_json", "source", "kind", "derives_from", "file_path", "created_at", "updated_at"]) {
      expect(cols).toContain(expected);
    }
  });
});
