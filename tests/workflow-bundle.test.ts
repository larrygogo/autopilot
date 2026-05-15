/**
 * 工作流 JSON bundle 导出 / 导入测试。
 * 路由层不测（HTTP 框架级），核心校验 saveAuthoredWorkflow 复用路径。
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { saveAuthoredWorkflow } from "../src/daemon/workflow-author";

let tmpHome: string;

beforeEach(() => {
  tmpHome = join(tmpdir(), `autopilot-bundle-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "workflows"), { recursive: true });
  process.env.AUTOPILOT_HOME = tmpHome;
});

afterEach(() => {
  delete process.env.AUTOPILOT_HOME;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe("workflow bundle import path（复用 saveAuthoredWorkflow）", () => {
  it("普通 bundle 导入：yaml + ts 写入新目录", () => {
    saveAuthoredWorkflow(
      "imported_dev",
      `name: imported_dev\nphases:\n  - name: do_it\n`,
      `export async function run_do_it(_t: string): Promise<void> {}\n`,
    );
    expect(existsSync(join(tmpHome, "workflows", "imported_dev", "workflow.yaml"))).toBe(true);
    expect(existsSync(join(tmpHome, "workflows", "imported_dev", "workflow.ts"))).toBe(true);
    const yaml = readFileSync(join(tmpHome, "workflows", "imported_dev", "workflow.yaml"), "utf-8");
    expect(yaml).toContain("name: imported_dev");
  });

  it("零代码 bundle（ts 为空字符串）→ 不写 workflow.ts 文件", () => {
    saveAuthoredWorkflow(
      "prompt_only",
      `name: prompt_only\nphases:\n  - name: do\n    prompt: hi\n`,
      "",
    );
    expect(existsSync(join(tmpHome, "workflows", "prompt_only", "workflow.yaml"))).toBe(true);
    expect(existsSync(join(tmpHome, "workflows", "prompt_only", "workflow.ts"))).toBe(false);
  });

  it("目标已存在 → 抛错", () => {
    mkdirSync(join(tmpHome, "workflows", "dup"), { recursive: true });
    writeFileSync(join(tmpHome, "workflows", "dup", "workflow.yaml"), "name: dup\n");
    expect(() => saveAuthoredWorkflow("dup", "name: dup\n", "")).toThrow(/already exists/);
  });

  it("名字非法 → 抛错", () => {
    expect(() => saveAuthoredWorkflow("bad name!", "x", "x")).toThrow(/只允许/);
  });
});
