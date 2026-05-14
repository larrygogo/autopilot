import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { listWorkflowTemplates, cloneTemplate } from "../src/core/workflow-templates";

let tmpHome: string;

beforeEach(() => {
  tmpHome = join(tmpdir(), `autopilot-wf-templates-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "workflows"), { recursive: true });
  process.env.AUTOPILOT_HOME = tmpHome;
});

afterEach(() => {
  delete process.env.AUTOPILOT_HOME;
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

  it("跳过没有 workflow.yaml 的目录（如 README.md）", () => {
    const list = listWorkflowTemplates();
    // 不应出现 README 之类的项
    expect(list.some((t) => t.name === "README.md")).toBe(false);
  });
});

describe("cloneTemplate", () => {
  it("拷贝模板到 AUTOPILOT_HOME/workflows/<name>/", () => {
    cloneTemplate("dev", "my-dev");
    const dst = join(tmpHome, "workflows", "my-dev", "workflow.yaml");
    expect(existsSync(dst)).toBe(true);
    const yaml = readFileSync(dst, "utf-8");
    expect(yaml).toContain("name: dev");  // 拷贝来源的 name 仍是 dev——用户自己改
  });

  it("目标已存在 → 抛错", () => {
    mkdirSync(join(tmpHome, "workflows", "exists"), { recursive: true });
    writeFileSync(join(tmpHome, "workflows", "exists", "workflow.yaml"), "name: exists\n", "utf-8");
    expect(() => cloneTemplate("dev", "exists")).toThrow(/already exists/);
  });

  it("模板不存在 → 抛错", () => {
    expect(() => cloneTemplate("__nonexistent__", "x")).toThrow(/not found/);
  });
});
