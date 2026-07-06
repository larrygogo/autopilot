/**
 * P1 后：parseTemplateRevision 从 JSON 字符串（workflow.json 内容）取顶层 template_revision。
 * examples 模板均为 workflow.json，revision 是 JSON 数字字段；YAML 正则版已删除。
 */
import { describe, expect, test } from "bun:test";
import { parseTemplateRevision } from "../src/core/workflow/templates";

describe("parseTemplateRevision（从 JSON 字符串取 template_revision）", () => {
  test("缺失字段 → 0（老副本天然落后）", () => {
    expect(parseTemplateRevision(JSON.stringify({ name: "dev", label: "x" }))).toBe(0);
  });

  test("纯数字字段", () => {
    expect(parseTemplateRevision(JSON.stringify({ name: "dev", template_revision: 3, label: "x" }))).toBe(3);
  });

  test("revision 是 0 → 0（合法）", () => {
    expect(parseTemplateRevision(JSON.stringify({ name: "dev", template_revision: 0 }))).toBe(0);
  });

  test("非数字 template_revision → 0（格式错误）", () => {
    expect(parseTemplateRevision(JSON.stringify({ template_revision: "abc" }))).toBe(0);
  });

  test("解析失败（非 JSON）→ 0", () => {
    expect(parseTemplateRevision("not json at all")).toBe(0);
  });

  test("空字符串 → 0", () => {
    expect(parseTemplateRevision("")).toBe(0);
  });
});
