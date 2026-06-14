import { describe, it, expect } from "bun:test";
import { expandPhaseDefaults } from "../src/core/registry";

// expandPhaseDefaults(phase, allPhaseNames) 是 yaml 加载时逐 phase 展开（含 reject 语法糖 +
// decision lint）的入口。直接喂 phase 对象即可单测 lint，无需起完整工作流。
function expand(phase: Record<string, unknown>, names: string[] = []) {
  return expandPhaseDefaults(phase, new Set(names));
}

describe("decision 配置 lint", () => {
  it("decision 但无 reject 目标 → 报错", () => {
    expect(() => expand({ name: "review", prompt: "判", decision: { pass: "P", reject: "R" } }))
      .toThrow(/回退目标|reject: <目标阶段>/);
  });

  it("decision × gate 互斥 → 报错", () => {
    expect(() =>
      expand(
        { name: "review", reject: "design", gate: true, prompt: "判", decision: { pass: "P", reject: "R" } },
        ["design", "review"],
      ),
    ).toThrow(/gate.*decision|互斥/);
  });

  it("decision 缺 pass/reject 字段 → 报错", () => {
    expect(() =>
      expand({ name: "review", reject: "design", prompt: "判", decision: { pass: "P" } }, ["design", "review"]),
    ).toThrow(/pass 与 reject/);
  });

  it("decision 非对象 → 报错", () => {
    expect(() =>
      expand({ name: "review", reject: "design", prompt: "判", decision: "oops" }, ["design", "review"]),
    ).toThrow(/必须是对象/);
  });

  it("合法 decision（有 reject 目标）→ 不报错", () => {
    expect(() =>
      expand({ name: "review", reject: "design", prompt: "判", decision: { pass: "P", reject: "R" } }, ["design", "review"]),
    ).not.toThrow();
  });

  it("无 decision → 不受影响", () => {
    expect(() => expand({ name: "design", prompt: "做" })).not.toThrow();
  });
});
