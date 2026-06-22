import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { runWorkflowAuthor, saveAuthoredWorkflow, _setAuthorFnForTest } from "../src/daemon/workflow-author";
import { up as m001 } from "../src/migrations/001-baseline";
import { up as m007 } from "../src/migrations/007-workflows";
import { up as m048 } from "../src/migrations/048-workflow-kind-spec-json";
import { _setDbForTest } from "../src/core/db";
import { getWorkflowFromDb } from "../src/core/workflow/workflows";

let tmpHome: string;
let db: Database;

beforeEach(() => {
  tmpHome = join(tmpdir(), `autopilot-author-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "workflows"), { recursive: true });
  process.env.AUTOPILOT_HOME = tmpHome;
  db = new Database(":memory:");
  m001(db); m007(db); m048(db);
  _setDbForTest(db);
});

afterEach(() => {
  _setAuthorFnForTest(null);
  _setDbForTest(null);
  db.close();
  delete process.env.AUTOPILOT_HOME;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe("runWorkflowAuthor（声明式，零 ts）", () => {
  it("正常路径返回 name + 声明式 yaml（无 ts 字段）", async () => {
    _setAuthorFnForTest(async () =>
      JSON.stringify({
        name: "my_dev",
        description: "测试用",
        yaml: "name: my_dev\ndescription: 测试用\nphases:\n  - name: design\n    prompt: 做设计 ${REQUIREMENT}\n",
      }),
    );
    const r = await runWorkflowAuthor({ description: "做一个简单工作流" });
    expect(r.name).toBe("my_dev");
    expect(r.yaml).toContain("phases:");
    expect((r as unknown as Record<string, unknown>).ts).toBeUndefined(); // 不再有 ts
    expect(r.warnings.length).toBe(0);
  });

  it("LLM 抛错走兜底，stub yaml 带 prompt（声明式可跑）", async () => {
    _setAuthorFnForTest(async () => { throw new Error("provider down"); });
    const r = await runWorkflowAuthor({ description: "做点啥" });
    expect(r.yaml).toContain("prompt:");
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("AI 返回非法格式走兜底", async () => {
    _setAuthorFnForTest(async () => "not yaml object");
    const r = await runWorkflowAuthor({ description: "x" });
    expect(r.warnings.some((w) => w.includes("格式") || w.includes("非法"))).toBe(true);
  });

  it("phase 既无 prompt 也无 gate/deliver → warning（声明式跑不起来）", async () => {
    _setAuthorFnForTest(async () =>
      `name: x
description: x
yaml: |
  name: x
  phases:
    - name: design
      prompt: 做
    - name: review
`,
    );
    const r = await runWorkflowAuthor({ description: "x" });
    expect(r.warnings.some((w) => w.includes("review"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("design"))).toBe(false);
  });

  it("全 prompt → 无 warning", async () => {
    _setAuthorFnForTest(async () =>
      JSON.stringify({
        name: "zero_code",
        description: "纯 prompt",
        yaml: "name: zero_code\nphases:\n  - name: draft\n    prompt: 写 ${REQUIREMENT}\n  - name: polish\n    prompt: 改进\n",
      }),
    );
    const r = await runWorkflowAuthor({ description: "测试" });
    expect(r.warnings.length).toBe(0);
  });

  it("gate / deliver phase 不报 warning（框架原语可跑）", async () => {
    _setAuthorFnForTest(async () =>
      `name: m
description: m
yaml: |
  name: m
  phases:
    - name: design
      prompt: 设计
    - name: approve
      gate: true
    - name: submit_pr
      deliver: pr
`,
    );
    const r = await runWorkflowAuthor({ description: "x" });
    expect(r.warnings.length).toBe(0);
  });

  it("误生成 func（代码引用）→ warning（声明式不支持）", async () => {
    _setAuthorFnForTest(async () =>
      `name: c
description: c
yaml: |
  name: c
  phases:
    - name: design
      prompt: 设计
      func: run_design
`,
    );
    const r = await runWorkflowAuthor({ description: "x" });
    expect(r.warnings.some((w) => w.includes("func") || w.includes("代码"))).toBe(true);
  });

  it("label 原样保留", async () => {
    _setAuthorFnForTest(async () =>
      `name: labeled
description: 测试 label
yaml: |
  name: labeled
  label: 完整开发
  phases:
    - name: design
      label: 设计
      prompt: 设计
`,
    );
    const r = await runWorkflowAuthor({ description: "测试" });
    expect(r.yaml).toContain("label: 完整开发");
    expect(r.yaml).toContain("label: 设计");
    expect(r.warnings.length).toBe(0);
  });
});

describe("saveAuthoredWorkflow（落 native DB，零 ts）", () => {
  it("落 native DB 工作流（kind=native + spec_json，不写磁盘）", () => {
    saveAuthoredWorkflow("my_wf", "name: my_wf\ndescription: d\nphases:\n  - name: a\n    prompt: x\n");
    const row = getWorkflowFromDb("my_wf");
    expect(row).not.toBeNull();
    expect(row!.kind).toBe("native");
    expect(JSON.parse(row!.spec_json!).phases[0].name).toBe("a");
    // 不写磁盘
    expect(existsSync(join(tmpHome, "workflows", "my_wf"))).toBe(false);
  });

  it("名字非法 → 抛错", () => {
    expect(() => saveAuthoredWorkflow("Bad Name!", "name: x\nphases:\n  - name: a\n    prompt: y\n")).toThrow();
  });

  it("已存在 → 抛错", () => {
    saveAuthoredWorkflow("dup", "name: dup\nphases:\n  - name: a\n    prompt: y\n");
    expect(() => saveAuthoredWorkflow("dup", "name: dup\nphases:\n  - name: a\n    prompt: z\n")).toThrow(/已存在|exists/);
  });

  it("缺 phases → 抛错", () => {
    expect(() => saveAuthoredWorkflow("nop", "name: nop\ndescription: d\n")).toThrow();
  });
});
