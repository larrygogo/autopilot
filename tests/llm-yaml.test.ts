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

  it("围栏包裹 + 字段值内嵌 ``` 代码块 → 不被拦腰截断（dogfood：clarifier missing/invalid done）", () => {
    const raw = [
      "```yaml",
      "new_spec_md: |",
      "  ## 背景",
      "  配置示例：",
      "  ```yaml",
      "  scheduler:",
      "    max_concurrency: 3",
      "  ```",
      "  以上是示例",
      "summary: 补充了配置示例",
      "next_question: null",
      "done: true",
      "```",
    ].join("\n");
    const result = parseLlmYamlWrapper(raw);
    expect(result.done).toBe(true);
    expect(result.next_question).toBeNull();
    expect(result.new_spec_md).toContain("max_concurrency: 3");
    expect(result.new_spec_md).toContain("以上是示例");
  });

  it("裸 YAML（无外层围栏）含内嵌 ``` 代码块 → 原样解析不剥", () => {
    const raw = [
      "new_spec_md: |",
      "  示例：",
      "  ```ts",
      "  function f() {}",
      "  ```",
      "done: false",
      "next_question:",
      "  agent_text: 继续吗？",
    ].join("\n");
    const result = parseLlmYamlWrapper(raw);
    expect(result.done).toBe(false);
    expect(result.new_spec_md).toContain("function f() {}");
  });

  it("围栏缺闭合（LLM 输出被截断）→ 剥开头围栏后仍解析", () => {
    const raw = "```yaml\nname: x\ndone: true";
    expect(parseLlmYamlWrapper(raw)).toEqual({ name: "x", done: true });
  });

  it("前导说明文字 + 围栏块 → 提取围栏内容（模型不听'只输出 YAML'时兜底）", () => {
    const raw = "好的，以下是修订结果：\n```yaml\nname: x\ndone: true\n```";
    expect(parseLlmYamlWrapper(raw)).toEqual({ name: "x", done: true });
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

  it("多文档 `---` 分隔 → 抛中文化 YAML 解析错（#16，带语义提示而非裸英文）", () => {
    // yaml.parse 对多文档抛英文 "Source contains multiple documents..."；这条会落进
    // clarifier_error 给用户看，必须包上中文壳 + 提示（原始英文首行作线索保留在括号内）。
    const raw = "name: x\n---\nname: y";
    expect(() => parseLlmYamlWrapper(raw)).toThrow(/YAML 解析失败/);
    expect(() => parseLlmYamlWrapper(raw)).toThrow(/多文档分隔/);
  });

  it("制表符缩进 → 抛中文化 YAML 解析错（#16，带语义化提示）", () => {
    // YAML 不允许 tab 缩进；裸 parse 抛英文，需翻译。
    const raw = "name:\n\tfoo: bar";
    expect(() => parseLlmYamlWrapper(raw)).toThrow(/YAML 解析失败/);
    expect(() => parseLlmYamlWrapper(raw)).toThrow(/缩进|制表符/);
  });
});
