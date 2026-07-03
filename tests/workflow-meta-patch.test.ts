/**
 * patchWorkflowMetaSpec（P2 後：JSON spec 操作）：声明层 requires.git 的写键 / 删键 / 空 map 清理 + 容错，
 * 保留其他字段。纯函数单测。
 * （2026-06-22：sandbox.git 从 requires.git 派生、delivers 从 phase 派生，均不再是 meta 字段，
 *  故只剩 requires.git；optional 第三态废弃，二态。）
 * （P2 2026-06-30：yaml_content 列已删除，patchWorkflowMetaYaml 改为 JSON 操作的别名，
 *  测试统一使用 patchWorkflowMetaSpec + JSON spec。）
 */
import { describe, it, expect } from "bun:test";
import { patchWorkflowMetaSpec } from "../src/core/workflow/registry-authoring";

const BASE = JSON.stringify({
  name: "demo",
  label: "演示流",
  phases: [{ name: "step1", timeout: 900 }],
});

describe("patchWorkflowMetaYaml 声明层（requires.git 二态）", () => {
  it("requires.git=true 写键；null 删键并清空 requires 壳", () => {
    const set = patchWorkflowMetaSpec(BASE, { requiresGit: true });
    const setDoc = JSON.parse(set) as Record<string, unknown>;
    expect(setDoc["requires"]).toBeDefined();
    expect((setDoc["requires"] as Record<string, unknown>)["git"]).toBe(true);

    const cleared = patchWorkflowMetaSpec(set, { requiresGit: null });
    const clearedDoc = JSON.parse(cleared) as Record<string, unknown>;
    expect(clearedDoc["requires"]).toBeUndefined();
  });

  it("requires.git=false 是有意义的显式值（不删键）", () => {
    const out = patchWorkflowMetaSpec(BASE, { requiresGit: false });
    const doc = JSON.parse(out) as Record<string, unknown>;
    expect(doc["requires"]).toBeDefined();
    expect((doc["requires"] as Record<string, unknown>)["git"]).toBe(false);
  });

  it("保留无关段（phases / name 不动）", () => {
    const out = patchWorkflowMetaSpec(BASE, { requiresGit: true });
    const doc = JSON.parse(out) as Record<string, unknown>;
    expect(doc["name"]).toBe("demo");
    const phases = doc["phases"] as unknown[];
    expect(Array.isArray(phases)).toBe(true);
    expect((phases[0] as Record<string, unknown>)["name"]).toBe("step1");
  });

  it("容错：requires 为 null 标量（被写坏状态）→ 整体替换成 map", () => {
    // 造一个 requires 为 null（"被写坏状态"）
    const bad1 = JSON.stringify({ name: "d", requires: null, phases: [{ name: "a" }] });
    const out = patchWorkflowMetaSpec(bad1, { requiresGit: true });
    const doc = JSON.parse(out) as Record<string, unknown>;
    expect((doc["requires"] as Record<string, unknown>)["git"]).toBe(true);
  });

  it("容错：requires 为字符串（被写坏状态）→ 整体替换成 map", () => {
    const bad2 = JSON.stringify({ name: "d", requires: "weird", phases: [{ name: "a" }] });
    const out = patchWorkflowMetaSpec(bad2, { requiresGit: true });
    const doc = JSON.parse(out) as Record<string, unknown>;
    expect((doc["requires"] as Record<string, unknown>)["git"]).toBe(true);
  });

  it("容错：删 requires.git（requiresGit=null）时 requires 缺失 / 非 map 也不抛", () => {
    // 真实根因：表单发 requiresGit=null → 走删键分支；dev 根本没有 requires 键
    const noReq = JSON.stringify({ name: "d", phases: [{ name: "a" }] });
    expect(() => patchWorkflowMetaSpec(noReq, { requiresGit: null })).not.toThrow();
    const out = patchWorkflowMetaSpec(noReq, { requiresGit: null });
    const doc = JSON.parse(out) as Record<string, unknown>;
    expect(doc["requires"]).toBeUndefined();

    for (const bad of [
      JSON.stringify({ name: "d", requires: null, phases: [{ name: "a" }] }),
      JSON.stringify({ name: "d", requires: "weird", phases: [{ name: "a" }] }),
    ]) {
      expect(() => patchWorkflowMetaSpec(bad, { requiresGit: null })).not.toThrow();
      const d = JSON.parse(patchWorkflowMetaSpec(bad, { requiresGit: null })) as Record<string, unknown>;
      expect(d["requires"]).toBeUndefined();
    }
  });

  it("undefined 字段完全不动 spec", () => {
    const out = patchWorkflowMetaSpec(BASE, { label: "新名" });
    const doc = JSON.parse(out) as Record<string, unknown>;
    expect(doc["requires"]).toBeUndefined();
    expect(doc["label"]).toBe("新名");
  });
});
