import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { handleRequest } from "../src/daemon/routes";
import { _setDbForTest, initDb } from "../src/core/db";
import { runPendingMigrations } from "../src/core/migrate";
import { createProject, nextProjectId } from "../src/core/projects";
import { createCodebase, nextCodebaseId } from "../src/core/codebases";
import { _setExtractFnForTest } from "../src/daemon/requirement-extract";

let tmpHome: string;
let projectId: string;
let codebaseId: string;

beforeEach(async () => {
  tmpHome = join(tmpdir(), `autopilot-extract-api-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "runtime"), { recursive: true });
  process.env.AUTOPILOT_HOME = tmpHome;
  process.env.DEV_WORKFLOW_CONFIG = join(tmpHome, "config.yaml");
  writeFileSync(
    join(tmpHome, "config.yaml"),
    "providers:\n  anthropic:\n    enabled: true\n    default_model: x\nagents:\n  coder:\n    provider: anthropic\n",
    "utf-8",
  );
  _setDbForTest(new Database(":memory:"));
  initDb();
  await runPendingMigrations();
  projectId = nextProjectId();
  createProject({ id: projectId, name: "test" });
  codebaseId = nextCodebaseId();
  createCodebase({ id: codebaseId, project_id: projectId, alias: "cb", path: "/tmp/x" });
  _setExtractFnForTest(async () =>
    JSON.stringify({ title: "测试标题", spec_md: "## 背景\nx\n## 目标\ny\n## 验收\nz" }),
  );
});

afterEach(() => {
  _setDbForTest(null);
  _setExtractFnForTest(null);
  delete process.env.AUTOPILOT_HOME;
  delete process.env.DEV_WORKFLOW_CONFIG;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe("POST /api/requirements/extract", () => {
  it("正常路径返回 title + spec_md", async () => {
    const res = await handleRequest(
      new Request("http://127.0.0.1:6180/api/requirements/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ raw_text: "做个登录", project_id: projectId }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toBe("测试标题");
    expect(body.spec_md).toContain("## 背景");
  });

  it("缺 raw_text → 400", async () => {
    const res = await handleRequest(
      new Request("http://127.0.0.1:6180/api/requirements/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project_id: projectId }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("缺 project_id → 400", async () => {
    const res = await handleRequest(
      new Request("http://127.0.0.1:6180/api/requirements/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ raw_text: "x" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("project_id 不存在 → 404", async () => {
    const res = await handleRequest(
      new Request("http://127.0.0.1:6180/api/requirements/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ raw_text: "x", project_id: "proj-999" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("codebase_id 不属于 project → 400", async () => {
    const otherProj = nextProjectId();
    createProject({ id: otherProj, name: "other" });
    const otherCb = nextCodebaseId();
    createCodebase({ id: otherCb, project_id: otherProj, alias: "cb2", path: "/tmp/y" });
    const res = await handleRequest(
      new Request("http://127.0.0.1:6180/api/requirements/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ raw_text: "x", project_id: projectId, codebase_id: otherCb }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("LLM 失败仍返回 200 + 兜底", async () => {
    _setExtractFnForTest(async () => {
      throw new Error("agent down");
    });
    const res = await handleRequest(
      new Request("http://127.0.0.1:6180/api/requirements/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ raw_text: "做个登录", project_id: projectId }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toBe("做个登录");
    expect(body.spec_md).toBe("做个登录");
  });
});
