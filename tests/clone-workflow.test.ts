import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { cloneWorkflow } from "../src/core/workflow/templates";

let tmpHome: string;

beforeEach(() => {
  tmpHome = join(tmpdir(), `autopilot-clone-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "workflows"), { recursive: true });
  process.env.AUTOPILOT_HOME = tmpHome;
});

afterEach(() => {
  delete process.env.AUTOPILOT_HOME;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

function mkSrc(name: string, yamlBody: string, tsBody?: string) {
  const dir = join(tmpHome, "workflows", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "workflow.yaml"), yamlBody, "utf-8");
  if (tsBody !== undefined) {
    writeFileSync(join(dir, "workflow.ts"), tsBody, "utf-8");
  }
}

describe("cloneWorkflow", () => {
  it("从用户已有的工作流克隆到新目录 + 自动改新 yaml 的 name", () => {
    mkSrc(
      "my_dev",
      `name: my_dev
description: 我的工作流
phases:
  - name: do_it
    prompt: hi
`,
      `// custom\nexport async function run_do_it() {}\n`,
    );

    cloneWorkflow("my_dev", "my_dev_v2");
    const dstYaml = readFileSync(join(tmpHome, "workflows", "my_dev_v2", "workflow.yaml"), "utf-8");
    expect(dstYaml).toMatch(/^name: my_dev_v2/m);
    expect(dstYaml).not.toMatch(/^name: my_dev$/m);
    // ts 也一并拷贝
    expect(existsSync(join(tmpHome, "workflows", "my_dev_v2", "workflow.ts"))).toBe(true);
  });

  it("克隆带 ts 的工作流：yaml + ts 都完整拷贝", () => {
    mkSrc(
      "with_ts",
      `name: with_ts\nphases:\n  - name: x\n`,
      `export async function run_x(_t: string): Promise<void> {\n  console.log("hi");\n}\n`,
    );

    cloneWorkflow("with_ts", "with_ts_copy");
    const copyTs = readFileSync(join(tmpHome, "workflows", "with_ts_copy", "workflow.ts"), "utf-8");
    expect(copyTs).toContain('console.log("hi")');
  });

  it("源工作流不存在 → 抛错", () => {
    expect(() => cloneWorkflow("not_here", "anywhere")).toThrow(/source workflow not found/);
  });

  it("目标已存在 → 抛错", () => {
    mkSrc("a", `name: a\nphases: []\n`);
    mkSrc("b", `name: b\nphases: []\n`);
    expect(() => cloneWorkflow("a", "b")).toThrow(/already exists/);
  });

  it("目标名非法 → 抛错", () => {
    mkSrc("a", `name: a\nphases: []\n`);
    expect(() => cloneWorkflow("a", "bad name!")).toThrow(/只允许/);
  });

  it("源没有 workflow.yaml → 抛错", () => {
    mkdirSync(join(tmpHome, "workflows", "empty"), { recursive: true });
    expect(() => cloneWorkflow("empty", "target")).toThrow(/no workflow\.yaml/);
  });

  it("克隆 prompt-only 工作流（无 workflow.ts）正常 — 不创建空 ts 文件", () => {
    mkSrc(
      "prompt_only",
      `name: prompt_only\nphases:\n  - name: do\n    prompt: hi\n`,
      // 不提供 ts
    );

    cloneWorkflow("prompt_only", "prompt_only_copy");
    expect(existsSync(join(tmpHome, "workflows", "prompt_only_copy", "workflow.yaml"))).toBe(true);
    // 源没 ts，副本也不该凭空多出 ts 文件
    expect(existsSync(join(tmpHome, "workflows", "prompt_only_copy", "workflow.ts"))).toBe(false);
  });
});
