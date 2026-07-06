import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate007 } from "../src/migrations/007-workflows";
import { up as migrate048 } from "../src/migrations/048-workflow-kind-spec-json";
import { _setDbForTest } from "../src/core/db";
import { _clearRegistry, discover, getWorkflow } from "../src/core/workflow/registry";
import { createDbWorkflow, createNativeDbWorkflow } from "../src/core/workflow/workflows";
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
    // setup 一次：创建 tmp home（file 轨已退役，不再写磁盘工作流）
    tmpHome = join(tmpdir(), `autopilot-w2-routes-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpHome, "workflows"), { recursive: true });
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

  /** 每次测试前重建 req_dev native base + discover，确保派生测试有 base 可用 */
  function seedReqDev() {
    createNativeDbWorkflow({
      name: "req_dev",
      description: "",
      spec_json: JSON.stringify({
        name: "req_dev",
        phases: [
          { name: "design", timeout: 60, prompt: "做设计" },
          { name: "develop", timeout: 60, prompt: "开发" },
        ],
      }),
    });
  }

  beforeEach(async () => {
    db.run("DELETE FROM workflows");
    _clearRegistry();
    seedReqDev();
    await discover();
  });

  it("workflows.import（JSON）无 derives_from → 独立 native 落 DB + 注册", async () => {
    const r = await invokeRpcMethod("workflows.import", {
      name: "imp_native",
      content: JSON.stringify({ name: "imp_native", phases: [{ name: "a", timeout: 60, prompt: "做 a" }] }),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.payload as { kind: string }).kind).toBe("native");
    const row = db.query<{ kind: string; spec_json: string | null }, []>(
      "SELECT kind, spec_json FROM workflows WHERE name='imp_native'"
    ).get();
    expect(row?.kind).toBe("native");
    expect(JSON.parse(row!.spec_json!).phases[0].name).toBe("a");
    expect(getWorkflow("imp_native")).not.toBeNull(); // import 内 reloadRegistry
  });

  it("workflows.import（JSON）有 derives_from → 派生(derived)（base 是 native）", async () => {
    // req_dev 已在 beforeEach 作为 native 种入
    const r = await invokeRpcMethod("workflows.import", {
      name: "imp_derived",
      derives_from: "req_dev",
      content: JSON.stringify({ name: "imp_derived", phases: [{ name: "design", timeout: 30 }] }),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.payload as { kind: string }).kind).toBe("derived");
  });

  it("workflows.import 拒非 JSON（yaml 文本）→ INVALID_PARAM", async () => {
    const r = await invokeRpcMethod("workflows.import", {
      name: "imp_yaml", content: "name: x\nphases:\n  - name: a\n",
    });
    expect(r.ok).toBe(false); // 用户面统一 JSON，yaml 文本不再接受
  });

  it("export → import json 往返：native spec 等价（除 name）", async () => {
    await invokeRpcMethod("workflows.import", {
      name: "rt_src",
      content: JSON.stringify({ name: "rt_src", label: "往返", phases: [{ name: "a", timeout: 60, prompt: "x" }, { name: "b", timeout: 60, prompt: "y", reject: "a" }] }),
    });
    const exp = await invokeRpcMethod("workflows.export", { name: "rt_src" });
    expect(exp.ok).toBe(true);
    if (!exp.ok) return;
    const json = (exp.payload as { content: string }).content;
    const reimport = await invokeRpcMethod("workflows.import", { name: "rt_dst", content: json });
    expect(reimport.ok).toBe(true);
    const a = JSON.parse(db.query<{ spec_json: string }, []>("SELECT spec_json FROM workflows WHERE name='rt_src'").get()!.spec_json);
    const b = JSON.parse(db.query<{ spec_json: string }, []>("SELECT spec_json FROM workflows WHERE name='rt_dst'").get()!.spec_json);
    delete a.name; delete b.name;
    expect(b).toEqual(a);
  });

  it("workflows.import 缺 phases → INVALID_PARAM 拒绝", async () => {
    const r = await invokeRpcMethod("workflows.import", { name: "imp_bad", content: '{"name":"imp_bad"}' });
    expect(r.ok).toBe(false);
  });

  it("workflows.list 响应包含 source / derives_from（native base）", async () => {
    const r = await invokeRpcMethod("workflows.list", {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      const body = r.payload as Array<{ name: string; source: string; derives_from: string | null }>;
      const reqDev = body.find((w) => w.name === "req_dev");
      expect(reqDev).toBeDefined();
      expect(reqDev!.source).toBe("db"); // native 工作流 source=db
      expect(reqDev!.derives_from).toBeNull();
    }
  });

  it("POST /api/workflows 带 derives_from → 走 native DB 创建（file 轨已退役）", async () => {
    // file 轨已退役，POST /api/workflows 统一建 native DB 行，source:"db"。
    const res = await handleRequest(
      new Request("http://localhost/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "req_dev_fast",
          description: "skip review",
          derives_from: "req_dev",
        }),
      }),
      fakeLoopbackServer,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; name: string; source: string };
    expect(body.ok).toBe(true);
    expect(body.name).toBe("req_dev_fast");
    expect(body.source).toBe("db"); // native 工作流 source=db
  });

  it("workflows.saveSpec 修改 DB 工作流走 updateDbWorkflow（P2 后 saveYaml 返回 GONE）", async () => {
    createNativeDbWorkflow({
      name: "wf_db",
      description: "",
      spec_json: JSON.stringify({ name: "wf_db", phases: [{ name: "design", timeout: 60, prompt: "做设计" }] }),
    });
    _clearRegistry();
    await discover();

    // P2：saveYaml 已退役，改用 saveSpec（JSON spec 文本）
    const newSpec = JSON.stringify({ name: "wf_db", phases: [{ name: "design", prompt: "做设计" }, { name: "develop", prompt: "开发" }] });
    const saveR = await invokeRpcMethod("workflows.saveSpec", { name: "wf_db", spec: newSpec });
    expect(saveR.ok).toBe(true);

    // saveYaml 现在返回 GONE
    const goneR = await invokeRpcMethod("workflows.saveYaml", { name: "wf_db", yaml: "anything" });
    expect(goneR.ok).toBe(false);

    // 验证 DB 里 phase 数量真的改了
    const getR = await invokeRpcMethod("workflows.getSpec", { name: "wf_db" });
    expect(getR.ok).toBe(true);
    if (getR.ok) {
      const body = getR.payload as { spec: string };
      expect(body.spec).toContain("develop"); // 新增的 develop 阶段已写入
    }
  });

  it("workflows.delete 删 DB 工作流", async () => {
    createNativeDbWorkflow({
      name: "wf_to_delete",
      description: "",
      spec_json: JSON.stringify({ name: "wf_to_delete", phases: [{ name: "a", timeout: 60, prompt: "x" }] }),
    });
    _clearRegistry();
    await discover();

    const delR = await invokeRpcMethod("workflows.delete", { name: "wf_to_delete" });
    expect(delR.ok).toBe(true);

    const getR = await invokeRpcMethod("workflows.get", { name: "wf_to_delete" });
    expect(getR.ok).toBe(false);
    if (!getR.ok) expect(getR.error.code).toBe("NOT_FOUND");
  });

  it("GET /api/workflows/:name/export 返回 JSON spec（P2 后 yaml 已退役）", async () => {
    createNativeDbWorkflow({
      name: "wf_export",
      description: "",
      spec_json: JSON.stringify({ name: "wf_export", phases: [{ name: "design", timeout: 60, prompt: "做设计" }] }),
    });
    _clearRegistry();
    await discover();

    const res = await handleRequest(new Request("http://localhost/api/workflows/wf_export/export"), fakeLoopbackServer);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/json/);
    const text = await res.text();
    const doc = JSON.parse(text) as { name?: string };
    expect(doc.name).toBe("wf_export");
  });

  it("GET /api/workflows/:name/export native base 也支持（返回 JSON）", async () => {
    // req_dev 是 native DB 工作流（file 轨已退役）
    const res = await handleRequest(new Request("http://localhost/api/workflows/req_dev/export"), fakeLoopbackServer);
    expect(res.status).toBe(200);
    const text = await res.text();
    const doc = JSON.parse(text) as { name?: string };
    expect(doc.name).toBe("req_dev");
  });

  it("GET /api/workflows/:name/export 不存在 → 404", async () => {
    const res = await handleRequest(new Request("http://localhost/api/workflows/no_such/export"), fakeLoopbackServer);
    expect(res.status).toBe(404);
  });
});
