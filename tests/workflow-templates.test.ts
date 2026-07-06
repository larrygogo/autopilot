/**
 * P1 后：examples 模板均为 workflow.json；cloneTemplate 改为 DB 种植（不再拷磁盘文件）；
 * diffWorkflowTemplate / syncWorkflowTemplate 已删（file 轨退役）。
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
import { getWorkflowFromDb } from "../src/core/workflow/workflows";
import {
  listWorkflowTemplates,
  cloneTemplate,
} from "../src/core/workflow/templates";

let tmpHome: string;
let db: Database;

beforeEach(() => {
  tmpHome = join(tmpdir(), `autopilot-wf-templates-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe("listWorkflowTemplates", () => {
  it("能扫到 examples/workflows 下的内置模板（至少 dev）", () => {
    const list = listWorkflowTemplates();
    expect(list.length).toBeGreaterThan(0);
    const dev = list.find((t) => t.name === "dev");
    expect(dev).toBeDefined();
    expect(dev!.description).toBeTruthy();
    expect(dev!.phase_count).toBeGreaterThan(0);
  });

  it("json 顶层 label 字段会回传到模板列表", () => {
    const list = listWorkflowTemplates();
    // examples/workflows/dev/workflow.json 已写 label: 完整开发
    const dev = list.find((t) => t.name === "dev");
    expect(dev!.label).toBe("完整开发");
  });

  it("prompt-only 工作流（无 workflow.ts）也能作为模板出现", () => {
    const list = listWorkflowTemplates();
    const pq = list.find((t) => t.name === "prompt_quick");
    expect(pq).toBeDefined();
    expect(pq!.label).toBe("提示词速写");
    expect(pq!.phase_count).toBe(2);
    // 移除命名复用 agent 后，agent 改为 phase 内联，agents[] 块为空 → agent_count 0
    expect(pq!.agent_count).toBe(0);
  });

  it("json 没写 label 时 label 字段为 undefined", () => {
    const list = listWorkflowTemplates();
    for (const t of list) {
      // label 必须要么是非空字符串、要么是 undefined（不会是 null / 空串）
      expect(t.label === undefined || (typeof t.label === "string" && t.label.length > 0)).toBe(true);
    }
  });

  it("跳过没有 workflow.json 的目录（如 README.md）", () => {
    const list = listWorkflowTemplates();
    // 不应出现 README 之类的项
    expect(list.some((t) => t.name === "README.md")).toBe(false);
  });
});

describe("cloneTemplate（P1：DB 种植）", () => {
  it("克隆模板到 DB native 行，name 改为 targetName", () => {
    cloneTemplate("dev", "my-dev");
    const row = getWorkflowFromDb("my-dev");
    expect(row).not.toBeNull();
    expect(row!.source).toBe("db");
    expect(row!.kind).toBe("native");
    // spec_json 中 name 已改为 targetName
    const spec = JSON.parse(row!.spec_json!) as { name?: string; phases?: unknown[] };
    expect(spec.name).toBe("my-dev");
    expect(Array.isArray(spec.phases)).toBe(true);
    // 不应在磁盘写任何文件
    const diskPath = join(tmpHome, "workflows", "my-dev");
    expect(existsSync(diskPath)).toBe(false);
  });

  it("目标已存在（DB 中已有）→ 抛错", () => {
    cloneTemplate("dev", "my-dev");
    expect(() => cloneTemplate("dev", "my-dev")).toThrow(/already exists/);
  });

  it("模板不存在 → 抛错（含模板名 + 已有模板列表）", () => {
    expect(() => cloneTemplate("__nonexistent__", "x")).toThrow(/不存在|not found/);
  });
});
