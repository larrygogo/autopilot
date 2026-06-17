import { describe, expect, test } from "bun:test";
import { parseTemplateRevision } from "../src/core/workflow/templates";

describe("parseTemplateRevision（顶层 template_revision 提取）", () => {
  test("缺失字段 → 0（老副本天然落后）", () => {
    expect(parseTemplateRevision("name: dev\nlabel: x\n")).toBe(0);
  });

  test("纯数字字段", () => {
    expect(parseTemplateRevision("name: dev\ntemplate_revision: 3\nlabel: x\n")).toBe(3);
  });

  test("容忍行尾注释", () => {
    expect(parseTemplateRevision("name: dev\ntemplate_revision: 5   # 改了就 +1\n")).toBe(5);
  });

  test("只认顶层（行首），缩进的不算", () => {
    expect(parseTemplateRevision("phases:\n  - template_revision: 9\n")).toBe(0);
  });

  test("非数字值不匹配 → 0", () => {
    expect(parseTemplateRevision("template_revision: abc\n")).toBe(0);
  });
});
