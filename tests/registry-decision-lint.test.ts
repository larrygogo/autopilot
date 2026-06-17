import { describe, it, expect } from "bun:test";
import { expandPhaseDefaults } from "../src/core/workflow/registry";

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

  it("judge 模式已移除 → 报错并提示改用 tool", () => {
    expect(() =>
      expand(
        { name: "review", reject: "design", prompt: "判", decision: { mode: "judge", criteria: "需有测试" } },
        ["design", "review"],
      ),
    ).toThrow(/judge.*已移除|改用 "tool"|改用 tool/);
  });

  it("非法 mode → 报错", () => {
    expect(() =>
      expand({ name: "review", reject: "design", prompt: "判", decision: { mode: "vote" } }, ["design", "review"]),
    ).toThrow(/marker.*tool|mode/);
  });

  it("tool 模式无需 pass/reject 标记 → 不报错", () => {
    expect(() =>
      expand(
        { name: "review", reject: "design", prompt: "判", decision: { mode: "tool", criteria: "需有测试" } },
        ["design", "review"],
      ),
    ).not.toThrow();
  });

  it("tool 模式仍需 reject 回退目标 → 缺则报错", () => {
    expect(() => expand({ name: "review", prompt: "判", decision: { mode: "tool" } }))
      .toThrow(/回退目标|reject: <目标阶段>/);
  });

  it("tool 模式 × gate 互斥 → 报错", () => {
    expect(() =>
      expand(
        { name: "review", reject: "design", gate: true, prompt: "判", decision: { mode: "tool" } },
        ["design", "review"],
      ),
    ).toThrow(/gate.*decision|互斥/);
  });

  it("tool 模式带 criteria（${CRITERIA} 注入用）→ 不报错", () => {
    expect(() =>
      expand(
        { name: "review", reject: "design", prompt: "判", decision: { mode: "tool", criteria: "覆盖需求即通过" } },
        ["design", "review"],
      ),
    ).not.toThrow();
  });
});
