/**
 * requirements.extract RPC method 端到端测试（之前测 HTTP /api/requirements/extract）。
 * HTTP endpoint 已删除，业务逻辑通过 invokeRpcMethod("requirements.extract") 走 WS RPC 注册表。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { _setDbForTest, initDb } from "../src/core/db";
import { runPendingMigrations } from "../src/core/migrate";
import { createProject, nextProjectId } from "../src/core/projects";
import { createCodebase, nextCodebaseId } from "../src/core/codebases";
import { _setExtractFnForTest } from "../src/daemon/requirement-extract";
import { invokeRpcMethod } from "../src/daemon/rpc";
import { registerCoreRpcMethods } from "../src/daemon/rpc-methods";

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
  // RPC 注册幂等（多次调用安全）
  registerCoreRpcMethods();
  projectId = nextProjectId();
  createProject({ id: projectId, name: "test" });
  codebaseId = nextCodebaseId();
  createCodebase({ id: codebaseId, project_id: projectId, alias: "cb", path: "/tmp/x" });
  _setExtractFnForTest(async () =>
    "title: 测试标题\nspec_md: |\n  ## 背景\n  x\n  ## 目标\n  y\n  ## 验收\n  z",
  );
});

afterEach(() => {
  _setDbForTest(null);
  _setExtractFnForTest(null);
  delete process.env.AUTOPILOT_HOME;
  delete process.env.DEV_WORKFLOW_CONFIG;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe("requirements.extract RPC", () => {
  it("正常路径返回 title + spec_md", async () => {
    const r = await invokeRpcMethod("requirements.extract", {
      raw_text: "做个登录",
      project_id: projectId,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const body = r.payload as { title: string; spec_md: string };
      expect(body.title).toBe("测试标题");
      expect(body.spec_md).toContain("## 背景");
    }
  });

  it("缺 raw_text → INVALID_PARAM", async () => {
    const r = await invokeRpcMethod("requirements.extract", { project_id: projectId });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_PARAM");
  });

  it("缺 project_id → INVALID_PARAM", async () => {
    const r = await invokeRpcMethod("requirements.extract", { raw_text: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_PARAM");
  });

  it("project_id 不存在 → NOT_FOUND", async () => {
    const r = await invokeRpcMethod("requirements.extract", {
      raw_text: "x",
      project_id: "proj-999",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("NOT_FOUND");
  });

  it("codebase_id 不属于 project → INVALID_PARAM", async () => {
    const otherProj = nextProjectId();
    createProject({ id: otherProj, name: "other" });
    const otherCb = nextCodebaseId();
    createCodebase({ id: otherCb, project_id: otherProj, alias: "cb2", path: "/tmp/y" });
    const r = await invokeRpcMethod("requirements.extract", {
      raw_text: "x",
      project_id: projectId,
      codebase_id: otherCb,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_PARAM");
  });

  it("LLM 失败仍返回 ok + 兜底（fallback 跑回 raw_text 当 title）", async () => {
    _setExtractFnForTest(async () => {
      throw new Error("agent down");
    });
    const r = await invokeRpcMethod("requirements.extract", {
      raw_text: "做个登录",
      project_id: projectId,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const body = r.payload as { title: string; spec_md: string };
      expect(body.title).toBe("做个登录");
      expect(body.spec_md).toBe("做个登录");
    }
  });
});
