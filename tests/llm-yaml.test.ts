import { describe, it, expect } from "bun:test";
import { parseLlmYamlWrapper } from "../src/core/llm-yaml";

describe("parseLlmYamlWrapper", () => {
  it("纯 YAML 顶层对象 → 解析", () => {
    const raw = "name: dev\ndescription: hi";
    expect(parseLlmYamlWrapper(raw)).toEqual({ name: "dev", description: "hi" });
  });

  it("剥 ```yaml 围栏", () => {
    const raw = "```yaml\nname: x\n```";
    expect(parseLlmYamlWrapper(raw)).toEqual({ name: "x" });
  });

  it("剥紧凑 ```yaml 围栏（无换行）", () => {
    const raw = "```yaml name: x\ndescription: y\n```";
    expect(parseLlmYamlWrapper(raw)).toEqual({ name: "x", description: "y" });
  });

  it("剥 ```json 围栏（兼容旧 prompt 输出 JSON）", () => {
    const raw = '```json\n{"name":"x","ts":""}\n```';
    expect(parseLlmYamlWrapper(raw)).toEqual({ name: "x", ts: "" });
  });

  it("YAML 是 JSON 超集 → 老的纯 JSON 输出仍然能 parse（向后兼容）", () => {
    const raw = '{"name":"old","ts":"old"}';
    expect(parseLlmYamlWrapper(raw)).toEqual({ name: "old", ts: "old" });
  });

  it("| 多行块 + prompt 字段内嵌未转义双引号 → 完整保留", () => {
    // 这是真实 daemon log 里挂掉 JSON 的 case，用 YAML 后零转义
    const raw = `name: test
yaml: |
  phases:
    - prompt: |
        请输出"测试通过"并重复需求`;
    const result = parseLlmYamlWrapper(raw);
    expect(result.name).toBe("test");
    expect(typeof result.yaml).toBe("string");
    expect(result.yaml).toContain('"测试通过"');
  });

  it("嵌套 phases 数组 → 解析", () => {
    const raw = `name: dev
phases:
  - name: design
    timeout: 900
  - name: review
    timeout: 600`;
    expect(parseLlmYamlWrapper(raw)).toEqual({
      name: "dev",
      phases: [
        { name: "design", timeout: 900 },
        { name: "review", timeout: 600 },
      ],
    });
  });

  it("空字符串 → 抛", () => {
    expect(() => parseLlmYamlWrapper("")).toThrow();
    expect(() => parseLlmYamlWrapper("   ")).toThrow();
  });

  it("顶层是字符串 → 抛（防 LLM 返回纯说明文字）", () => {
    expect(() => parseLlmYamlWrapper("not yaml object")).toThrow(/不是对象/);
  });

  it("顶层是数组 → 抛", () => {
    expect(() => parseLlmYamlWrapper("- a\n- b\n- c")).toThrow(/不是对象/);
  });
});
