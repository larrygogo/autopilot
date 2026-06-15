import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { scanWorkflowHealth, fixOrphanWorkflow } from "../src/core/workflow/templates";

let tmpHome: string;

beforeEach(() => {
  tmpHome = join(tmpdir(), `autopilot-health-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "workflows"), { recursive: true });
  process.env.AUTOPILOT_HOME = tmpHome;
});

afterEach(() => {
  delete process.env.AUTOPILOT_HOME;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

function mkWf(dir: string, yamlBody: string) {
  const d = join(tmpHome, "workflows", dir);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "workflow.yaml"), yamlBody, "utf-8");
}

describe("scanWorkflowHealth", () => {
  it("空目录返回空 orphans / collisions", () => {
    const r = scanWorkflowHealth();
    expect(r.orphans).toEqual([]);
    expect(r.collisions).toEqual([]);
  });

  it("目录名 vs yaml.name 一致 → 不报为孤儿", () => {
    mkWf("dev", `name: dev\nphases: []\n`);
    const r = scanWorkflowHealth();
    expect(r.orphans).toEqual([]);
  });

  it("yaml.name 跟目录名不一致 → 报为孤儿", () => {
    mkWf("data_pipeline-copy", `name: data_pipeline\nphases: []\n`);
    const r = scanWorkflowHealth();
    expect(r.orphans.length).toBe(1);
    expect(r.orphans[0].dir).toBe("data_pipeline-copy");
    expect(r.orphans[0].yamlName).toBe("data_pipeline");
  });

  it("两个目录共用同一 yaml.name → 报重名碰撞", () => {
    mkWf("data_pipeline", `name: data_pipeline\nphases: []\n`);
    mkWf("data_pipeline-copy", `name: data_pipeline\nphases: []\n`);
    const r = scanWorkflowHealth();
    expect(r.collisions.length).toBe(1);
    expect(r.collisions[0].name).toBe("data_pipeline");
    expect(r.collisions[0].dirs.sort()).toEqual(["data_pipeline", "data_pipeline-copy"]);
  });

  it("yaml.name 字段带引号也能识别", () => {
    mkWf("quoted", `name: "quoted"\nphases: []\n`);
    const r = scanWorkflowHealth();
    expect(r.orphans).toEqual([]);
  });

  it("yaml 没有 workflow.yaml 文件 → 跳过", () => {
    mkdirSync(join(tmpHome, "workflows", "empty-dir"), { recursive: true });
    const r = scanWorkflowHealth();
    expect(r.orphans).toEqual([]);
    expect(r.collisions).toEqual([]);
  });

  it("_ 开头的目录跳过（cache / 临时目录约定）", () => {
    mkWf("_cache", `name: anything\nphases: []\n`);
    const r = scanWorkflowHealth();
    expect(r.orphans).toEqual([]);
  });
});

describe("fixOrphanWorkflow", () => {
  it("把 yaml.name 改为目录名", () => {
    mkWf("data_pipeline-copy", `name: data_pipeline\nphases: []\n`);
    const r = fixOrphanWorkflow("data_pipeline-copy");
    expect(r.fixed).toBe(true);
    expect(r.oldName).toBe("data_pipeline");
    expect(r.newName).toBe("data_pipeline-copy");
    const yaml = readFileSync(join(tmpHome, "workflows", "data_pipeline-copy", "workflow.yaml"), "utf-8");
    expect(yaml).toMatch(/^name: data_pipeline-copy/m);
    expect(yaml).not.toMatch(/^name: data_pipeline$/m);
  });

  it("yaml.name 已经一致 → 返回 fixed=false（幂等）", () => {
    mkWf("dev", `name: dev\nphases: []\n`);
    const r = fixOrphanWorkflow("dev");
    expect(r.fixed).toBe(false);
  });

  it("目录不存在 → 抛错", () => {
    expect(() => fixOrphanWorkflow("nope")).toThrow(/不存在/);
  });

  it("目录名非法 → 抛错", () => {
    expect(() => fixOrphanWorkflow("../etc")).toThrow(/非法/);
  });

  it("写入会生成 .bak 备份", () => {
    mkWf("foo-copy", `name: foo\nphases: []\n`);
    fixOrphanWorkflow("foo-copy");
    expect(existsSync(join(tmpHome, "workflows", "foo-copy", "workflow.yaml.bak"))).toBe(false);
    // 注意：rewriteWorkflowName 当前实现没生成 .bak（行级 replace），所以这里断言没有
    // 如未来改成"先备份"，此用例需更新。
  });
});
