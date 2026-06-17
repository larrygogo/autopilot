import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import {
  parseWorkflowText,
  stringifyWorkflowDoc,
  exportWorkflowContent,
  detectFormat,
} from "../src/core/workflow/serialize";

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
  it("解析 yaml", () => {
    const doc = parseWorkflowText(SAMPLE_YAML, "yaml") as Record<string, unknown>;
    expect(doc.name).toBe("demo");
    expect((doc.phases as unknown[]).length).toBe(2);
  });

  it("解析 json", () => {
    const doc = parseWorkflowText('{"name":"demo","phases":[]}', "json") as Record<string, unknown>;
    expect(doc.name).toBe("demo");
  });
});

describe("exportWorkflowContent", () => {
  it("yaml 格式 = 原样返回（保注释 / 排版，零损失）", () => {
    const withComment = "# 顶部注释\nname: x\nphases: []\n";
    expect(exportWorkflowContent(withComment, "yaml")).toBe(withComment);
  });

  it("json 格式 = 结构原生 json（不是 yaml 串塞 json）", () => {
    const json = exportWorkflowContent(SAMPLE_YAML, "json");
    const parsed = JSON.parse(json);
    // 原生：顶层就是 name/phases，而非 {yaml: "..."}
    expect(parsed.name).toBe("demo");
    expect(parsed.yaml).toBeUndefined();
    expect(parsed.phases[1].reject).toBe("design");
  });
});

describe("yaml ↔ json 往返保结构", () => {
  it("yaml → json → 对象 等于 直接 parseYaml(yaml)", () => {
    const json = exportWorkflowContent(SAMPLE_YAML, "json");
    expect(JSON.parse(json)).toEqual(parseYaml(SAMPLE_YAML));
  });

  it("对象 → yaml → 对象 幂等", () => {
    const obj = parseYaml(SAMPLE_YAML);
    const back = parseYaml(stringifyWorkflowDoc(obj, "yaml"));
    expect(back).toEqual(obj);
  });

  it("对象 → json → 对象 幂等", () => {
    const obj = parseYaml(SAMPLE_YAML);
    const back = JSON.parse(stringifyWorkflowDoc(obj, "json"));
    expect(back).toEqual(obj);
  });
});

describe("detectFormat", () => {
  it("按扩展名", () => {
    expect(detectFormat("anything", ".json")).toBe("json");
    expect(detectFormat("anything", ".yaml")).toBe("yaml");
    expect(detectFormat("anything", ".yml")).toBe("yaml");
  });
  it("无扩展名按内容嗅探", () => {
    expect(detectFormat('{"name":"x"}')).toBe("json");
    expect(detectFormat("name: x\n")).toBe("yaml");
    expect(detectFormat("  \n  { \"a\": 1 }")).toBe("json"); // 前导空白
  });
});

describe("真实工作流 golden 往返（examples/dev）", () => {
  it("dev workflow.yaml → 原生 json → 解析回来 等于 parseYaml", () => {
    const devYaml = readFileSync(join(import.meta.dir, "../examples/workflows/dev/workflow.yaml"), "utf-8");
    const json = exportWorkflowContent(devYaml, "json");
    expect(JSON.parse(json)).toEqual(parseYaml(devYaml));
  });
});
