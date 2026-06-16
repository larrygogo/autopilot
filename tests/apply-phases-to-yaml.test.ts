import { describe, it, expect } from "bun:test";
import { applyPhasesToYaml } from "../src/core/workflow/registry-authoring";
import type { PhaseEntryInput } from "../src/core/workflow/registry";

// applyPhasesToYaml 是 file / db 来源工作流共用的纯函数：校验 phases + 把它写进 yaml 文本的
// phases 段、保留其他字段与注释。db 来源工作流的编辑器保存就靠它（不再无条件写文件）。
describe("applyPhasesToYaml（file/db 共用）", () => {
  const base = `name: demo
delivers: pr
sandbox:
  git: true
phases:
  - name: a
    timeout: 100
`;

  it("替换 phases 段、保留其他顶层字段", () => {
    const out = applyPhasesToYaml(base, [
      { name: "a", timeout: 200 },
      { name: "b", reject: "a" },
    ] as PhaseEntryInput[]);
    expect(out).toContain("delivers: pr"); // 其他字段保留
    expect(out).toContain("git: true");
    expect(out).toContain("name: b");
    expect(out).toContain("reject: a");
    expect(out).toContain("200");
  });

  it("reject 指向其后阶段（非往回跳）→ 抛错", () => {
    expect(() =>
      applyPhasesToYaml(base, [{ name: "a", reject: "b" }, { name: "b" }] as PhaseEntryInput[]),
    ).toThrow(/往回跳|reject/);
  });

  it("空 phases → 抛错", () => {
    expect(() => applyPhasesToYaml(base, [] as PhaseEntryInput[])).toThrow(/不能为空/);
  });

  it("重复阶段名 → 抛错", () => {
    expect(() =>
      applyPhasesToYaml(base, [{ name: "a" }, { name: "a" }] as PhaseEntryInput[]),
    ).toThrow(/重复/);
  });
});
