import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate007 } from "../src/migrations/007-workflows";
import { up as migrate048 } from "../src/migrations/048-workflow-kind-spec-json";
import { _setDbForTest } from "../src/core/db";
import { _clearRegistry, discover } from "../src/core/workflow/registry";
import { createDbWorkflow } from "../src/core/workflow/workflows";
import { handleRequest } from "../src/daemon/routes";

// 模拟 loopback 来源让 checkAuth 豁免 token（测试场景 daemon 可能已设 token）
const fakeLoopbackServer = {
  requestIP: () => ({ address: "127.0.0.1", port: 0, family: "IPv4" }),
} as unknown as import("bun").Server<undefined>;
import { invokeRpcMethod } from "../src/daemon/rpc";
import { registerCoreRpcMethods } from "../src/daemon/rpc-methods";

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
    migrate048(db);
    _setDbForTest(db);
    registerCoreRpcMethods();
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

  it("workflows.list 响应包含 source / derives_from", async () => {
    const r = await invokeRpcMethod("workflows.list", {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      const body = r.payload as Array<{ name: string; source: string; derives_from: string | null }>;
      const reqDev = body.find((w) => w.name === "req_dev");
      expect(reqDev).toBeDefined();
      expect(reqDev!.source).toBe("file");
      expect(reqDev!.derives_from).toBeNull();
    }
  });

  it("POST /api/workflows 带 derives_from → 不再走派生分支，走文件脚手架（兼容历史调用）", async () => {
    // 派生功能 UI 已下线（"派生鸡肋"），POST /api/workflows 不再识别 derives_from，
    // 改为统一走文件脚手架。旧调用方仍能创建 file 工作流，只是 derives_from 字段被忽略。
    const res = await handleRequest(
      new Request("http://localhost/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "req_dev_fast",
          description: "skip review",
          derives_from: "req_dev", // 被忽略
        }),
      }),
      fakeLoopbackServer,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; name: string; source: string };
    expect(body.ok).toBe(true);
    expect(body.name).toBe("req_dev_fast");
    expect(body.source).toBe("file");
  });

  it("workflows.saveYaml 修改 DB 工作流走 updateDbWorkflow", async () => {
    createDbWorkflow({
      name: "wf_db",
      description: "",
      derives_from: "req_dev",
      yaml_content: "name: wf_db\nphases:\n  - name: design\n",
    });
    _clearRegistry();
    await discover();

    const newYaml = "name: wf_db\nphases:\n  - name: design\n  - name: develop\n";
    const saveR = await invokeRpcMethod("workflows.saveYaml", { name: "wf_db", yaml: newYaml });
    expect(saveR.ok).toBe(true);

    // 验证 DB 里 yaml 真的改了
    const getR = await invokeRpcMethod("workflows.getYaml", { name: "wf_db" });
    expect(getR.ok).toBe(true);
    if (getR.ok) {
      const body = getR.payload as { yaml: string };
      expect(body.yaml).toBe(newYaml);
    }
  });

  it("workflows.delete 删 DB 工作流", async () => {
    createDbWorkflow({
      name: "wf_to_delete",
      description: "",
      derives_from: "req_dev",
      yaml_content: "name: wf_to_delete\nphases: []\n",
    });
    _clearRegistry();
    await discover();

    const delR = await invokeRpcMethod("workflows.delete", { name: "wf_to_delete" });
    expect(delR.ok).toBe(true);

    const getR = await invokeRpcMethod("workflows.get", { name: "wf_to_delete" });
    expect(getR.ok).toBe(false);
    if (!getR.ok) expect(getR.error.code).toBe("NOT_FOUND");
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

    const res = await handleRequest(new Request("http://localhost/api/workflows/wf_export/export"), fakeLoopbackServer);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/yaml|text/);
    const text = await res.text();
    expect(text).toContain("name: wf_export");
  });

  it("GET /api/workflows/:name/export 文件来源也支持", async () => {
    const res = await handleRequest(new Request("http://localhost/api/workflows/req_dev/export"), fakeLoopbackServer);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("name: req_dev");
  });

  it("GET /api/workflows/:name/export 不存在 → 404", async () => {
    const res = await handleRequest(new Request("http://localhost/api/workflows/no_such/export"), fakeLoopbackServer);
    expect(res.status).toBe(404);
  });
});
