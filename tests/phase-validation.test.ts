import { describe, it, expect } from "bun:test";
import { validatePhases, issuesForTop, fieldIssue, type Item } from "../src/web/src/components/phaseValidation";

function phase(name: string, timeout?: number, reject?: string | null): Item {
  return { kind: "phase", name, timeout, reject: reject ?? null, extras: {} };
}

function parallel(name: string, subs: Item[], fail_strategy?: string): Item {
  return { kind: "parallel", name, fail_strategy, phases: subs as any };
}

describe("validatePhases", () => {
  it("合法结构返回空数组", () => {
    expect(validatePhases([
      phase("step1", 900),
      phase("step2", 600, "step1"),
    ])).toEqual([]);
  });

  it("空数组给出提示", () => {
    const issues = validatePhases([]);
    expect(issues).toHaveLength(1);
    expect(issues[0].field).toBe("phases");
  });

  it("名称格式非法", () => {
    const issues = validatePhases([phase("Step 1", 900)]);
    expect(issues.some((i) => i.field === "name" && i.message.includes("小写字母"))).toBe(true);
  });

  it("名称为空", () => {
    const issues = validatePhases([phase("", 900)]);
    expect(issues.some((i) => i.message.includes("不能为空"))).toBe(true);
  });

  it("顶层名称重复", () => {
    const issues = validatePhases([phase("a"), phase("a")]);
    const dupes = issues.filter((i) => i.message.includes("重复"));
    expect(dupes.length).toBeGreaterThanOrEqual(2);
  });

  it("并行块内外名称重复检测", () => {
    const issues = validatePhases([
      phase("foo"),
      parallel("par", [phase("foo"), phase("bar")]),
    ]);
    expect(issues.some((i) => i.field === "name" && i.message.includes("重复"))).toBe(true);
  });

  it("timeout 必须是正整数", () => {
    for (const bad of [0, -1, 1.5, NaN]) {
      const issues = validatePhases([phase("a", bad)]);
      expect(issues.some((i) => i.field === "timeout")).toBe(true);
    }
  });

  it("timeout 未填允许", () => {
    expect(validatePhases([phase("a")])).toEqual([]);
  });

  it("reject 目标不存在", () => {
    const issues = validatePhases([phase("a", 900, "ghost")]);
    expect(issues.some((i) => i.field === "reject")).toBe(true);
  });

  it("reject 目标在自己之后", () => {
    const issues = validatePhases([phase("a", 900, "b"), phase("b")]);
    expect(issues.some((i) => i.field === "reject")).toBe(true);
  });

  it("reject 目标可以是并行块内的子阶段", () => {
    expect(validatePhases([
      parallel("dev", [phase("fe"), phase("be")]),
      phase("review", 900, "fe"),
    ])).toEqual([]);
  });

  it("并行块空子阶段报错", () => {
    const issues = validatePhases([parallel("dev", [])]);
    expect(issues.some((i) => i.field === "phases")).toBe(true);
  });

  it("fail_strategy 非法值报错", () => {
    const issues = validatePhases([parallel("dev", [phase("fe")], "invalid")]);
    expect(issues.some((i) => i.field === "fail_strategy")).toBe(true);
  });
});

describe("issuesForTop / fieldIssue", () => {
  it("按位置筛选并取字段", () => {
    const issues = validatePhases([phase(""), phase("")]);
    const first = issuesForTop(issues, 0);
    expect(first).toHaveLength(1);
    expect(fieldIssue(first, "name")).toBeDefined();
  });
});
