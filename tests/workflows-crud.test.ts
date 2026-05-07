import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate007 } from "../src/migrations/007-workflows";
import { _setDbForTest } from "../src/core/db";
import {
  listWorkflowsInDb,
  getWorkflowFromDb,
  createDbWorkflow,
  updateDbWorkflow,
  deleteDbWorkflow,
  upsertFileWorkflow,
} from "../src/core/workflows";

describe("workflows CRUD", () => {
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

  it("upsertFileWorkflow 插入新行", () => {
    const wf = upsertFileWorkflow({
      name: "req_dev",
      description: "需求驱动开发",
      yaml_content: "name: req_dev\nphases: []\n",
      file_path: "/tmp/wf/req_dev",
    });
    expect(wf.source).toBe("file");
    expect(wf.derives_from).toBeNull();
    expect(wf.file_path).toBe("/tmp/wf/req_dev");
  });

  it("upsertFileWorkflow 已存在时更新 yaml_content + updated_at", () => {
    const w1 = upsertFileWorkflow({
      name: "req_dev",
      description: "v1",
      yaml_content: "yaml: v1",
      file_path: "/tmp/wf/req_dev",
    });
    const w2 = upsertFileWorkflow({
      name: "req_dev",
      description: "v2",
      yaml_content: "yaml: v2",
      file_path: "/tmp/wf/req_dev",
    });
    expect(w2.yaml_content).toBe("yaml: v2");
    expect(w2.description).toBe("v2");
    expect(w2.updated_at).toBeGreaterThanOrEqual(w1.updated_at);
  });

  it("createDbWorkflow 必须 derives_from 一个 file workflow", () => {
    upsertFileWorkflow({
      name: "req_dev",
      description: "",
      yaml_content: "x",
      file_path: "/tmp/x",
    });
    const wf = createDbWorkflow({
      name: "req_dev_fast",
      description: "快速版",
      derives_from: "req_dev",
      yaml_content: "name: req_dev_fast\nphases: []\n",
    });
    expect(wf.source).toBe("db");
    expect(wf.derives_from).toBe("req_dev");
    expect(wf.file_path).toBeNull();
  });

  it("createDbWorkflow derives_from 不存在时报错", () => {
    expect(() =>
      createDbWorkflow({
        name: "wf_x",
        description: "",
        derives_from: "no_such",
        yaml_content: "x",
      })
    ).toThrow(/derives_from.*不存在/);
  });

  it("createDbWorkflow derives_from 指向 source=db 时报错（禁嵌套）", () => {
    upsertFileWorkflow({
      name: "req_dev",
      description: "",
      yaml_content: "x",
      file_path: "/tmp/x",
    });
    createDbWorkflow({
      name: "wf_db1",
      description: "",
      derives_from: "req_dev",
      yaml_content: "x",
    });
    expect(() =>
      createDbWorkflow({
        name: "wf_db2",
        description: "",
        derives_from: "wf_db1",
        yaml_content: "x",
      })
    ).toThrow(/嵌套|file/);
  });

  it("createDbWorkflow 同名冲突报错", () => {
    upsertFileWorkflow({
      name: "req_dev",
      description: "",
      yaml_content: "x",
      file_path: "/tmp/x",
    });
    createDbWorkflow({
      name: "wf_a",
      description: "",
      derives_from: "req_dev",
      yaml_content: "x",
    });
    expect(() =>
      createDbWorkflow({
        name: "wf_a",
        description: "",
        derives_from: "req_dev",
        yaml_content: "y",
      })
    ).toThrow();
  });

  it("updateDbWorkflow 仅修改 db 工作流", () => {
    upsertFileWorkflow({
      name: "req_dev",
      description: "",
      yaml_content: "x",
      file_path: "/tmp/x",
    });
    expect(() =>
      updateDbWorkflow("req_dev", { yaml_content: "y" })
    ).toThrow(/file|只读/);

    createDbWorkflow({
      name: "wf_a",
      description: "",
      derives_from: "req_dev",
      yaml_content: "x",
    });
    const updated = updateDbWorkflow("wf_a", {
      yaml_content: "y",
      description: "new desc",
    });
    expect(updated?.yaml_content).toBe("y");
    expect(updated?.description).toBe("new desc");
  });

  it("deleteDbWorkflow 仅删 db 工作流", () => {
    upsertFileWorkflow({
      name: "req_dev",
      description: "",
      yaml_content: "x",
      file_path: "/tmp/x",
    });
    expect(() => deleteDbWorkflow("req_dev")).toThrow(/file|只读/);

    createDbWorkflow({
      name: "wf_a",
      description: "",
      derives_from: "req_dev",
      yaml_content: "x",
    });
    deleteDbWorkflow("wf_a");
    expect(getWorkflowFromDb("wf_a")).toBeNull();
  });

  it("listWorkflowsInDb 列出全部 + 按 name 排序", () => {
    upsertFileWorkflow({
      name: "req_dev",
      description: "",
      yaml_content: "x",
      file_path: "/tmp/x",
    });
    createDbWorkflow({
      name: "wf_a",
      description: "",
      derives_from: "req_dev",
      yaml_content: "x",
    });
    createDbWorkflow({
      name: "wf_b",
      description: "",
      derives_from: "req_dev",
      yaml_content: "x",
    });
    const list = listWorkflowsInDb();
    expect(list.length).toBe(3);
    expect(list.map((w) => w.name).sort()).toEqual(["req_dev", "wf_a", "wf_b"]);
  });
});
