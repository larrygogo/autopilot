import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import { parseWorkflowText, stringifyWorkflowDoc } from "../src/core/workflow/serialize";

const SAMPLE_YAML = `name: demo
label: 演示
phases:
  - name: design
    timeout: 900
  - name: review
    timeout: 600
    reject: design
`;

describe("parseWorkflowText", () => {
  it("解析 yaml（内部用：file 工作流 / examples 模板）", () => {
    const doc = parseWorkflowText(SAMPLE_YAML, "yaml") as Record<string, unknown>;
    expect(doc.name).toBe("demo");
    expect((doc.phases as unknown[]).length).toBe(2);
  });

  it("解析 json（用户面导入）", () => {
    const doc = parseWorkflowText('{"name":"demo","phases":[]}', "json") as Record<string, unknown>;
    expect(doc.name).toBe("demo");
  });
});

describe("stringifyWorkflowDoc 往返保结构", () => {
  it("对象 → yaml → 对象 幂等（yaml 投影内部用）", () => {
    const obj = parseYaml(SAMPLE_YAML);
    expect(parseYaml(stringifyWorkflowDoc(obj, "yaml"))).toEqual(obj);
  });

  it("对象 → json → 对象 幂等（用户面导出/spec_json）", () => {
    const obj = parseYaml(SAMPLE_YAML);
    expect(JSON.parse(stringifyWorkflowDoc(obj, "json"))).toEqual(obj);
  });
});

describe("真实工作流 golden 往返（examples/dev）", () => {
  it("dev workflow.json → stringify → parse 幂等（P1 后 yaml 已删，改测 json 往返）", () => {
    const devJson = readFileSync(join(import.meta.dir, "../examples/workflows/dev/workflow.json"), "utf-8");
    const parsed = JSON.parse(devJson) as Record<string, unknown>;
    // json → stringify(json) → json 幂等
    const roundTripped = JSON.parse(stringifyWorkflowDoc(parsed, "json")) as Record<string, unknown>;
    expect(roundTripped).toEqual(parsed);
  });
});
