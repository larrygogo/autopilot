import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parseWorkflowText, stringifyWorkflowDoc } from "../src/core/workflow/serialize";

const SAMPLE_DOC = {
  name: "demo",
  label: "演示",
  phases: [
    { name: "design", timeout: 900 },
    { name: "review", timeout: 600, reject: "design" },
  ],
};

describe("parseWorkflowText（json-only）", () => {
  it("解析 json（用户面导入 / spec_json）", () => {
    const doc = parseWorkflowText('{"name":"demo","phases":[]}', "json") as Record<string, unknown>;
    expect(doc.name).toBe("demo");
  });

  it("非法 JSON 抛错", () => {
    expect(() => parseWorkflowText("name: demo\nphases: []", "json")).toThrow();
  });
});

describe("stringifyWorkflowDoc 往返保结构", () => {
  it("对象 → json → 对象 幂等（用户面导出/spec_json）", () => {
    expect(JSON.parse(stringifyWorkflowDoc(SAMPLE_DOC, "json"))).toEqual(SAMPLE_DOC);
  });

  it("输出末尾带换行（canonical）", () => {
    expect(stringifyWorkflowDoc(SAMPLE_DOC, "json").endsWith("\n")).toBe(true);
  });
});

describe("真实工作流 golden 往返（examples/dev）", () => {
  it("dev workflow.json → stringify → parse 幂等", () => {
    const devJson = readFileSync(join(import.meta.dir, "../examples/workflows/dev/workflow.json"), "utf-8");
    const parsed = JSON.parse(devJson) as Record<string, unknown>;
    const roundTripped = JSON.parse(stringifyWorkflowDoc(parsed, "json")) as Record<string, unknown>;
    expect(roundTripped).toEqual(parsed);
  });
});
