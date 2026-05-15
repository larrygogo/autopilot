import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runWorkflowAuthor, saveAuthoredWorkflow, _setAuthorFnForTest } from "../src/daemon/workflow-author";

let tmpHome: string;

beforeEach(() => {
  tmpHome = join(tmpdir(), `autopilot-author-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "workflows"), { recursive: true });
  process.env.AUTOPILOT_HOME = tmpHome;
});

afterEach(() => {
  _setAuthorFnForTest(null);
  delete process.env.AUTOPILOT_HOME;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe("runWorkflowAuthor", () => {
  it("正常路径返回 name + yaml + ts", async () => {
    _setAuthorFnForTest(async () =>
      JSON.stringify({
        name: "my_dev",
        description: "测试用",
        yaml: "name: my_dev\ndescription: 测试用\nphases:\n  - name: design\n    agent: coder\n    timeout: 900\n",
        ts: "export async function design(_taskId: string): Promise<void> {\n  // TODO\n}\n",
      }),
    );
    const r = await runWorkflowAuthor({ description: "做一个简单工作流" });
    expect(r.name).toBe("my_dev");
    expect(r.yaml).toContain("phases:");
    expect(r.ts).toContain("export async function design");
    expect(r.warnings.length).toBe(0);
  });

  it("LLM 抛错走兜底，给出 stub yaml/ts", async () => {
    _setAuthorFnForTest(async () => { throw new Error("provider down"); });
    const r = await runWorkflowAuthor({ description: "做点啥" });
    expect(r.yaml).toContain("name:");
    expect(r.ts).toContain("export async function");
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("AI 返回非法格式走兜底", async () => {
    // 现在顶层用 YAML 解析；"not json at all" 这种字符串 YAML 会解析成单个字符串，
    // 不是 object，触发 wrapper 顶层校验失败 → fallback
    _setAuthorFnForTest(async () => "not yaml object");
    const r = await runWorkflowAuthor({ description: "x" });
    expect(r.warnings.some((w) => w.includes("格式") || w.includes("非法"))).toBe(true);
  });

  it("AI 返回 YAML 但 ts 缺 phase 函数 → 报 warning，仍返回结果", async () => {
    _setAuthorFnForTest(async () =>
      // 顶层 YAML，yaml/ts 走 | 多行块
      `name: x
description: x
yaml: |
  name: x
  phases:
    - name: design
    - name: review
ts: |
  export async function design(_t: string): Promise<void> {}
`,
    );
    const r = await runWorkflowAuthor({ description: "x" });
    expect(r.warnings.some((w) => w.includes("review"))).toBe(true);
    expect(r.yaml).toContain("review");
  });

  it("AI 生成零代码工作流（所有 phase 都有 prompt） → ts 空字符串也接受，无 warning", async () => {
    _setAuthorFnForTest(async () =>
      JSON.stringify({
        name: "zero_code",
        description: "纯 prompt 工作流",
        yaml: `name: zero_code
phases:
  - name: draft
    prompt: 写一篇文章 \${REQUIREMENT}
  - name: polish
    prompt: 改进 \${WORKSPACE}/draft.md
`,
        ts: "",
      }),
    );
    const r = await runWorkflowAuthor({ description: "测试" });
    expect(r.name).toBe("zero_code");
    expect(r.ts).toBe("");
    expect(r.warnings.length).toBe(0);
  });

  it("AI 生成混合工作流（部分 phase 有 prompt，部分 ts）→ 只对没 prompt 也没 ts 的 phase 报 warning", async () => {
    _setAuthorFnForTest(async () =>
      JSON.stringify({
        name: "mixed",
        description: "混合",
        yaml: `name: mixed
phases:
  - name: draft
    prompt: 写
  - name: review
  - name: publish
`,
        ts: "export async function review(_t: string): Promise<void> {}\n",
      }),
    );
    const r = await runWorkflowAuthor({ description: "x" });
    // draft 有 prompt 不报，review 有 ts 不报，publish 既无 prompt 又无 ts → 报
    expect(r.warnings.some((w) => w.includes("publish"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("draft"))).toBe(false);
    expect(r.warnings.some((w) => w.includes("review"))).toBe(false);
  });

  it("AI 生成带 label 的 yaml 时，label 原样保留在文本里", async () => {
    _setAuthorFnForTest(async () =>
      JSON.stringify({
        name: "labeled",
        description: "测试 label",
        yaml: `name: labeled
label: 完整开发
phases:
  - name: design
    label: 设计
`,
        ts: "export async function design(_t: string): Promise<void> {}\n",
      }),
    );
    const r = await runWorkflowAuthor({ description: "测试" });
    expect(r.yaml).toContain("label: 完整开发");
    expect(r.yaml).toContain("label: 设计");
    expect(r.warnings.length).toBe(0);
  });
});

describe("saveAuthoredWorkflow", () => {
  it("落两个文件到 AUTOPILOT_HOME/workflows/<name>/", () => {
    saveAuthoredWorkflow("my_wf", "name: my_wf\n", "export async function x() {}\n");
    const dir = join(tmpHome, "workflows", "my_wf");
    expect(existsSync(join(dir, "workflow.yaml"))).toBe(true);
    expect(existsSync(join(dir, "workflow.ts"))).toBe(true);
    expect(readFileSync(join(dir, "workflow.yaml"), "utf-8")).toContain("name: my_wf");
  });

  it("名字非法 → 抛错", () => {
    expect(() => saveAuthoredWorkflow("bad name!", "x", "x")).toThrow(/只允许/);
  });

  it("目标已存在 → 抛错", () => {
    saveAuthoredWorkflow("dup", "x", "x");
    expect(() => saveAuthoredWorkflow("dup", "y", "y")).toThrow(/already exists/);
  });
});
