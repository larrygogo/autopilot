/**
 * 迁移 050：requirements 表 source/external_ref/callback_url/callback_secret 列
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { _setDbForTest, initDb } from "../src/core/db";
import { runPendingMigrations } from "../src/core/migrate";
import { up as m050 } from "../src/migrations/050-requirement-source-fields";
import { createProject } from "../src/core/projects";
import { createRequirement, getRequirementById } from "../src/core/requirements";

describe("migration-050: source 追踪列", () => {
  let db: Database;

  beforeAll(async () => {
    db = new Database(":memory:");
    _setDbForTest(db);
    initDb();
    await runPendingMigrations();
  });

  afterAll(() => {
    _setDbForTest(null);
    db.close();
  });

  beforeEach(() => {
    db.run("DELETE FROM requirements");
    db.run("DELETE FROM projects");
    createProject({ id: "p-test", name: "TestProject" });
  });

  it("迁移后列存在", () => {
    // 全量迁移（包含 050）已跑，校验列存在
    const cols = db
      .query<{ name: string }, []>("PRAGMA table_info(requirements)")
      .all()
      .map((c) => c.name);
    expect(cols.includes("source")).toBe(true);
    expect(cols.includes("external_ref")).toBe(true);
    expect(cols.includes("callback_url")).toBe(true);
    expect(cols.includes("callback_secret")).toBe(true);
  });

  it("迁移幂等：重跑不报错", () => {
    // 再跑一次 050（已存在列 → 跳过 ALTER）
    expect(() => m050(db)).not.toThrow();
  });

  it("createRequirement 写入 source/external_ref/callback_url/callback_secret", () => {
    const req = createRequirement({
      id: "req-001",
      project_id: "p-test",
      title: "来自 reqgenie 的需求",
      spec_md: "spec",
      source: "reqgenie",
      external_ref: "rg-uuid-123",
      callback_url: "https://reqgenie.example.com/webhook",
      callback_secret: "s3cr3t",
    });
    expect(req.source).toBe("reqgenie");
    expect(req.external_ref).toBe("rg-uuid-123");
    expect(req.callback_url).toBe("https://reqgenie.example.com/webhook");
    expect(req.callback_secret).toBe("s3cr3t");
  });

  it("不传新字段时默认 NULL（现有调用方零影响）", () => {
    const req = createRequirement({
      id: "req-002",
      project_id: "p-test",
      title: "普通需求",
    });
    expect(req.source).toBeNull();
    expect(req.external_ref).toBeNull();
    expect(req.callback_url).toBeNull();
    expect(req.callback_secret).toBeNull();
  });

  it("getRequirementById 能读到新字段", () => {
    createRequirement({
      id: "req-003",
      project_id: "p-test",
      title: "T",
      source: "test-src",
    });
    const found = getRequirementById("req-003");
    expect(found?.source).toBe("test-src");
    expect(found?.external_ref).toBeNull();
  });
});
