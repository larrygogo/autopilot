/**
 * P1 后：cloneWorkflow 只走 DB 分支（file 轨退役）。
 * 磁盘目录克隆路径已删，只测试 DB native/template/derived 克隆。
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { up as migrate001 } from "../src/migrations/001-baseline";
import { up as migrate007 } from "../src/migrations/007-workflows";
import { up as migrate048 } from "../src/migrations/048-workflow-kind-spec-json";
import { _setDbForTest } from "../src/core/db";
import { createNativeDbWorkflow, createDbWorkflow, getWorkflowFromDb } from "../src/core/workflow/workflows";
import { cloneWorkflow } from "../src/core/workflow/templates";

let tmpHome: string;
let db: Database;

beforeEach(() => {
  tmpHome = join(tmpdir(), `autopilot-clone-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "workflows"), { recursive: true });
  process.env.AUTOPILOT_HOME = tmpHome;
  db = new Database(":memory:");
  migrate001(db);
  migrate007(db);
  migrate048(db);
  _setDbForTest(db);
});

afterEach(() => {
  delete process.env.AUTOPILOT_HOME;
  _setDbForTest(null);
  db.close();
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe("cloneWorkflow（DB 分支）", () => {
  it("从 native DB 工作流克隆到新 native 行，name 改为 targetName", () => {
    const srcSpec = JSON.stringify({
      name: "my_dev",
      description: "源",
      phases: [{ name: "do_it", timeout: 60, prompt: "hi" }],
    });
    createNativeDbWorkflow({ name: "my_dev", description: "源", spec_json: srcSpec });

    cloneWorkflow("my_dev", "my_dev_v2");
    const row = getWorkflowFromDb("my_dev_v2");
    expect(row).not.toBeNull();
    expect(row!.source).toBe("db");
    expect(row!.kind).toBe("native");
    const spec = JSON.parse(row!.spec_json!) as { name?: string };
    expect(spec.name).toBe("my_dev_v2");
  });

  it("源工作流不存在 → 抛错", () => {
    expect(() => cloneWorkflow("not_here", "anywhere")).toThrow(/source workflow not found/);
  });

  it("目标已存在（DB 中已有）→ 抛错", () => {
    const specA = JSON.stringify({ name: "a", phases: [{ name: "x", timeout: 60, prompt: "x" }] });
    const specB = JSON.stringify({ name: "b", phases: [{ name: "y", timeout: 60, prompt: "y" }] });
    createNativeDbWorkflow({ name: "a", description: "", spec_json: specA });
    createNativeDbWorkflow({ name: "b", description: "", spec_json: specB });
    expect(() => cloneWorkflow("a", "b")).toThrow(/already exists/);
  });

  it("目标名非法 → 抛错", () => {
    const spec = JSON.stringify({ name: "a", phases: [{ name: "x", timeout: 60, prompt: "x" }] });
    createNativeDbWorkflow({ name: "a", description: "", spec_json: spec });
    expect(() => cloneWorkflow("a", "bad name!")).toThrow(/只允许/);
  });

  it("克隆 template 行 → native 行（可编辑）", () => {
    const spec = JSON.stringify({ name: "my_tpl", template_revision: 1, phases: [{ name: "x", timeout: 60 }] });
    // 直接插 template 行（通过 createNativeDbWorkflow 再手改 kind 模拟）
    db.run(
      "INSERT INTO workflows (name, description, yaml_content, spec_json, source, kind, derives_from, file_path, created_at, updated_at) VALUES (?, ?, '', ?, 'db', 'template', NULL, NULL, ?, ?)",
      ["my_tpl", "模板", spec, Date.now(), Date.now()],
    );

    cloneWorkflow("my_tpl", "my_clone");
    const row = getWorkflowFromDb("my_clone");
    expect(row).not.toBeNull();
    expect(row!.kind).toBe("native");
    const parsed = JSON.parse(row!.spec_json!) as { name?: string };
    expect(parsed.name).toBe("my_clone");
  });

  it("克隆 derived 行 → 新 derived 行（保留 derives_from + spec_json）", () => {
    // 先种 native base
    const baseSpec = JSON.stringify({ name: "base", phases: [{ name: "step", timeout: 60 }] });
    createNativeDbWorkflow({ name: "base", description: "", spec_json: baseSpec });
    // 种 derived
    createDbWorkflow({
      name: "derived_wf",
      description: "派生",
      derives_from: "base",
      spec_json: JSON.stringify({ phases: [{ name: "step", timeout: 120 }] }),
    });

    cloneWorkflow("derived_wf", "derived_wf_copy");
    const row = getWorkflowFromDb("derived_wf_copy");
    expect(row).not.toBeNull();
    expect(row!.kind).toBe("derived");
    expect(row!.derives_from).toBe("base");
  });
});
