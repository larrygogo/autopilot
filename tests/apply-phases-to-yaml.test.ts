import { describe, it, expect } from "bun:test";
import { applyPhasesToSpec } from "../src/core/workflow/registry-authoring";
import type { PhaseEntryInput } from "../src/core/workflow/registry";

// applyPhasesToSpec（P2 后：JSON spec 操作）：校验 phases + 把它写进 JSON spec 对象的
// phases 段、保留其他字段。db 来源工作流的编辑器保存走这条路径。
describe("applyPhasesToSpec（file/db 共用，P2 后 JSON）", () => {
  const base = JSON.stringify({
    name: "demo",
    delivers: "pr",
    sandbox: { git: true },
    phases: [{ name: "a", timeout: 100 }],
  });

  it("替换 phases 段、保留其他顶层字段", () => {
    const out = applyPhasesToSpec(base, [
      { name: "a", timeout: 200 },
      { name: "b", reject: "a" },
    ] as PhaseEntryInput[]);
    const doc = JSON.parse(out) as Record<string, unknown>;
    expect(doc["delivers"]).toBe("pr"); // 其他字段保留
    expect((doc["sandbox"] as Record<string, unknown>)["git"]).toBe(true);
    const phases = doc["phases"] as Array<Record<string, unknown>>;
    expect(phases.some((p) => p["name"] === "b")).toBe(true);
    expect(phases.some((p) => p["reject"] === "a")).toBe(true);
    expect(phases.some((p) => p["timeout"] === 200)).toBe(true);
  });

  it("reject 指向其后阶段（非往回跳）→ 抛错", () => {
    expect(() =>
      applyPhasesToSpec(base, [{ name: "a", reject: "b" }, { name: "b" }] as PhaseEntryInput[]),
    ).toThrow(/往回跳|reject/);
  });

  it("空 phases → 抛错", () => {
    expect(() => applyPhasesToSpec(base, [] as PhaseEntryInput[])).toThrow(/不能为空/);
  });

  it("重复阶段名 → 抛错", () => {
    expect(() =>
      applyPhasesToSpec(base, [{ name: "a" }, { name: "a" }] as PhaseEntryInput[]),
    ).toThrow(/重复/);
  });
});
