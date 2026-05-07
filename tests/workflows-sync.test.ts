import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate007 } from "../src/migrations/007-workflows";
import { _setDbForTest } from "../src/core/db";
import {
  syncFileWorkflowsToDb,
  listWorkflowsInDb,
  createDbWorkflow,
  upsertFileWorkflow,
} from "../src/core/workflows";

describe("syncFileWorkflowsToDb", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    migrate001(db);
    migrate007(db);
    _setDbForTest(db);
  });

  afterAll(() => {
    _setDbForTest(null);
    db.close();
  });

  beforeEach(() => {
    db.run("DELETE FROM workflows");
  });

  it("初始同步：DB 空 → 全部 insert", () => {
    const result = syncFileWorkflowsToDb([
      { name: "req_dev", description: "d1", yaml_content: "y1", file_path: "/tmp/req_dev" },
      { name: "scheduled", description: "d2", yaml_content: "y2", file_path: "/tmp/scheduled" },
    ]);
    expect(result.added.sort()).toEqual(["req_dev", "scheduled"]);
    expect(result.updated).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(listWorkflowsInDb().length).toBe(2);
  });

  it("yaml 变化：update + 不动 created_at", () => {
    upsertFileWorkflow({ name: "req_dev", description: "old", yaml_content: "y_old", file_path: "/tmp/req_dev" });
    const before = listWorkflowsInDb()[0];

    const result = syncFileWorkflowsToDb([
      { name: "req_dev", description: "new", yaml_content: "y_new", file_path: "/tmp/req_dev" },
    ]);
    expect(result.added).toEqual([]);
    expect(result.updated).toEqual(["req_dev"]);
    expect(result.removed).toEqual([]);

    const after = listWorkflowsInDb()[0];
    expect(after.yaml_content).toBe("y_new");
    expect(after.created_at).toBe(before.created_at);
    expect(after.updated_at).toBeGreaterThanOrEqual(before.updated_at);
  });

  it("文件被删：DB 中孤儿 file 工作流被清", () => {
    upsertFileWorkflow({ name: "req_dev", description: "", yaml_content: "x", file_path: "/tmp/req_dev" });
    upsertFileWorkflow({ name: "old_wf", description: "", yaml_content: "x", file_path: "/tmp/old_wf" });

    const result = syncFileWorkflowsToDb([
      { name: "req_dev", description: "", yaml_content: "x", file_path: "/tmp/req_dev" },
    ]);
    expect(result.removed).toEqual(["old_wf"]);
    expect(listWorkflowsInDb().map((w) => w.name)).toEqual(["req_dev"]);
  });

  it("DB 工作流不受 sync 影响", () => {
    upsertFileWorkflow({ name: "req_dev", description: "", yaml_content: "x", file_path: "/tmp/req_dev" });
    createDbWorkflow({ name: "wf_db", description: "", derives_from: "req_dev", yaml_content: "y" });

    syncFileWorkflowsToDb([
      { name: "req_dev", description: "", yaml_content: "x", file_path: "/tmp/req_dev" },
    ]);
    expect(listWorkflowsInDb().filter((w) => w.source === "db").map((w) => w.name)).toEqual(["wf_db"]);
  });

  it("yaml 没变：update 列表为空（按 yaml + description + file_path 比较）", () => {
    upsertFileWorkflow({ name: "req_dev", description: "d", yaml_content: "y", file_path: "/tmp/x" });
    const result = syncFileWorkflowsToDb([
      { name: "req_dev", description: "d", yaml_content: "y", file_path: "/tmp/x" },
    ]);
    expect(result.updated).toEqual([]);
    expect(result.added).toEqual([]);
  });
});
