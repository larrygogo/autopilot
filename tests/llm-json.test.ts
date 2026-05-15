import { describe, it, expect } from "bun:test";
import { parseLooseJson } from "../src/core/llm-json";

describe("parseLooseJson", () => {
  it("纯 JSON → 直接解析", () => {
    expect(parseLooseJson<{ a: number; b: string }>('{"a":1,"b":"hi"}')).toEqual({ a: 1, b: "hi" });
  });

  it("前后有空白 → 解析", () => {
    expect(parseLooseJson<{ a: number }>('  \n\n  {"a":1}  \n\n  ')).toEqual({ a: 1 });
  });

  it("```json 围栏 → 剥掉后解析", () => {
    const raw = '```json\n{"name":"dev","ts":""}\n```';
    expect(parseLooseJson<{ name: string; ts: string }>(raw)).toEqual({ name: "dev", ts: "" });
  });

  it("```JSON 围栏（大写） → 剥掉后解析", () => {
    expect(parseLooseJson<{ a: number }>('```JSON\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("``` 无语言 围栏 → 剥掉后解析", () => {
    expect(parseLooseJson<{ a: number }>('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("前缀说明文字 + JSON → 取 { ... } 子串解析", () => {
    const raw = '好的，下面是 JSON：\n{"name":"x","yaml":"phases:\\n  - name: do_it"}\n请检查。';
    expect(parseLooseJson<{ name: string; yaml: string }>(raw)).toEqual({
      name: "x",
      yaml: "phases:\n  - name: do_it",
    });
  });

  it("围栏 + 前缀说明 → 剥围栏后能直接解析", () => {
    const raw = "好的：\n```json\n{\"a\":1}\n```";
    // 优先剥围栏失败（因为前面有"好的："），但取 { ... } 子串能成功
    expect(parseLooseJson<{ a: number }>(raw)).toEqual({ a: 1 });
  });

  it("嵌套对象 → 完整解析", () => {
    const raw = '{"phases":[{"name":"design","timeout":900}]}';
    expect(parseLooseJson<{ phases: Array<{ name: string; timeout: number }> }>(raw)).toEqual({
      phases: [{ name: "design", timeout: 900 }],
    });
  });

  it("含 yaml 字符串字段（多行） → 解析后保留 \\n", () => {
    const raw = '{"yaml":"name: dev\\nphases:\\n  - name: code"}';
    const parsed = parseLooseJson<{ yaml: string }>(raw);
    expect(parsed.yaml).toBe("name: dev\nphases:\n  - name: code");
  });

  it("完全垃圾 → 抛 SyntaxError 含原文前缀", () => {
    expect(() => parseLooseJson("totally not json at all")).toThrow(SyntaxError);
    expect(() => parseLooseJson("totally not json at all")).toThrow(/totally not json/);
  });

  it("空字符串 → 抛", () => {
    expect(() => parseLooseJson("")).toThrow();
  });

  it("围栏内有未闭合 { → 走 brace fallback 也失败 → 抛", () => {
    expect(() => parseLooseJson('```json\n{"a":1\n```')).toThrow(SyntaxError);
  });

  it("数组返回（不是对象）→ 当前不支持兜底，但直接 parse 能过", () => {
    expect(parseLooseJson<number[]>("[1,2,3]")).toEqual([1, 2, 3]);
  });

  it("数组在围栏里 → 剥围栏后能 parse", () => {
    expect(parseLooseJson<number[]>("```json\n[1,2,3]\n```")).toEqual([1, 2, 3]);
  });
});
