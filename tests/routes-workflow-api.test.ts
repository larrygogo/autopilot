import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate007 } from "../src/migrations/007-workflows";
import { _setDbForTest } from "../src/core/db";
import { _clearRegistry, discover } from "../src/core/registry";
import { createDbWorkflow } from "../src/core/workflows";
import { handleRequest } from "../src/daemon/routes";

describe("workflows API（W2 扩展）", () => {
  let tmpHome: string;
  let db: Database;

  beforeAll(() => {
    // setup 一次：创建 tmp home + base 文件工作流
    tmpHome = join(tmpdir(), `autopilot-w2-routes-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpHome, "workflows", "req_dev"), { recursive: true });
    writeFileSync(
      join(tmpHome, "workflows", "req_dev", "workflow.yaml"),
      `name: req_dev\nphases:\n  - name: design\n    timeout: 60\n  - name: develop\n    timeout: 60\n`
    );
    writeFileSync(
      join(tmpHome, "workflows", "req_dev", "workflow.ts"),
      `export async function run_design() {}\nexport async function run_develop() {}\n`
    );
    process.env.AUTOPILOT_HOME = tmpHome;

    db = new Database(":memory:");
    migrate001(db);
    migrate007(db);
    _setDbForTest(db);
  });

  afterAll(() => {
    delete process.env.AUTOPILOT_HOME;
    _setDbForTest(null);
    db.close();
    _clearRegistry();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  beforeEach(async () => {
    db.run("DELETE FROM workflows");
    _clearRegistry();
    await discover();
  });

  it("GET /api/workflows 响应包含 source / derives_from", async () => {
    const res = await handleRequest(new Request("http://localhost/api/workflows"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ name: string; source: string; derives_from: string | null }>;
    const reqDev = body.find((w) => w.name === "req_dev");
    expect(reqDev).toBeDefined();
    expect(reqDev!.source).toBe("file");
    expect(reqDev!.derives_from).toBeNull();
  });

  it("POST /api/workflows 带 derives_from 创建 DB 工作流", async () => {
    const res = await handleRequest(
      new Request("http://localhost/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "req_dev_fast",
          description: "skip review",
          derives_from: "req_dev",
          yaml_content: "name: req_dev_fast\nphases:\n  - name: design\n",
        }),
      })
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; name: string; source: string };
    expect(body.ok).toBe(true);
    expect(body.name).toBe("req_dev_fast");
    expect(body.source).toBe("db");
  });

  it("POST /api/workflows derives_from 不存在的 base → 400", async () => {
    const res = await handleRequest(
      new Request("http://localhost/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "wf_x",
          derives_from: "no_such",
          yaml_content: "name: wf_x\nphases: []\n",
        }),
      })
    );
    expect(res.status).toBe(400);
  });

  it("PUT /api/workflows/:name/yaml 修改 DB 工作流走 updateDbWorkflow", async () => {
    createDbWorkflow({
      name: "wf_db",
      description: "",
      derives_from: "req_dev",
      yaml_content: "name: wf_db\nphases:\n  - name: design\n",
    });
    _clearRegistry();
    await discover();

    const newYaml = "name: wf_db\nphases:\n  - name: design\n  - name: develop\n";
    const res = await handleRequest(
      new Request("http://localhost/api/workflows/wf_db/yaml", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yaml: newYaml }),
      })
    );
    expect(res.status).toBe(200);

    // 验证 DB 里 yaml 真的改了
    const getRes = await handleRequest(new Request("http://localhost/api/workflows/wf_db/yaml"));
    const body = (await getRes.json()) as { yaml: string };
    expect(body.yaml).toBe(newYaml);
  });

  it("DELETE /api/workflows/:name 删 DB 工作流", async () => {
    createDbWorkflow({
      name: "wf_to_delete",
      description: "",
      derives_from: "req_dev",
      yaml_content: "name: wf_to_delete\nphases: []\n",
    });
    _clearRegistry();
    await discover();

    const res = await handleRequest(
      new Request("http://localhost/api/workflows/wf_to_delete", { method: "DELETE" })
    );
    expect(res.status).toBe(200);

    const getRes = await handleRequest(new Request("http://localhost/api/workflows/wf_to_delete"));
    expect(getRes.status).toBe(404);
  });

  it("GET /api/workflows/:name/export 返回纯 yaml 文本", async () => {
    createDbWorkflow({
      name: "wf_export",
      description: "",
      derives_from: "req_dev",
      yaml_content: "name: wf_export\nphases:\n  - name: design\n",
    });
    _clearRegistry();
    await discover();

    const res = await handleRequest(new Request("http://localhost/api/workflows/wf_export/export"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/yaml|text/);
    const text = await res.text();
    expect(text).toContain("name: wf_export");
  });

  it("GET /api/workflows/:name/export 文件来源也支持", async () => {
    const res = await handleRequest(new Request("http://localhost/api/workflows/req_dev/export"));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("name: req_dev");
  });

  it("GET /api/workflows/:name/export 不存在 → 404", async () => {
    const res = await handleRequest(new Request("http://localhost/api/workflows/no_such/export"));
    expect(res.status).toBe(404);
  });
});
