/**
 * patchWorkflowMetaYaml：声明层 requires.git 的写键 / 删键 / 空 map 清理 + 容错（被写坏状态不抛），
 * 保留注释与其他段。纯函数单测。
 * （2026-06-22：sandbox.git 从 requires.git 派生、delivers 从 phase 派生，均不再是 meta 字段，
 *  故只剩 requires.git；optional 第三态废弃，二态。）
 */
import { describe, it, expect } from "bun:test";
import { patchWorkflowMetaYaml } from "../src/core/workflow/registry-authoring";

const BASE = `name: demo
label: 演示流
# 这是阶段段的注释，应被保留
phases:
  - name: step1
    timeout: 900
`;

describe("patchWorkflowMetaYaml 声明层（requires.git 二态）", () => {
  it("requires.git=true 写键；null 删键并清空 requires 壳", () => {
    const set = patchWorkflowMetaYaml(BASE, { requiresGit: true });
    expect(set).toContain("requires:");
    expect(set).toMatch(/git:\s*true/);

    const cleared = patchWorkflowMetaYaml(set, { requiresGit: null });
    expect(cleared).not.toContain("requires:");
  });

  it("requires.git=false 是有意义的显式值（不删键）", () => {
    const out = patchWorkflowMetaYaml(BASE, { requiresGit: false });
    expect(out).toMatch(/requires:/);
    expect(out).toMatch(/git:\s*false/);
  });

  it("保留注释与无关段（phases / 注释不动）", () => {
    const out = patchWorkflowMetaYaml(BASE, { requiresGit: true });
    expect(out).toContain("# 这是阶段段的注释，应被保留");
    expect(out).toMatch(/phases:/);
    expect(out).toMatch(/step1/);
  });

  it("容错：requires 为 null 标量 / 字符串（被写坏状态）→ setIn 不抛，整体替换成 map", () => {
    // 复现用户报的 SAVE_FAILED「Expected YAML collection at requires. Remaining path: git」
    for (const bad of ["name: d\nrequires:\nphases:\n  - name: a\n", "name: d\nrequires: weird\nphases:\n  - name: a\n"]) {
      const out = patchWorkflowMetaYaml(bad, { requiresGit: true });
      expect(out).toMatch(/requires:\s*\n\s+git:\s*true/);
    }
  });

  it("容错：删 requires.git（requiresGit=null）时 requires 缺失 / 非 map 也不抛", () => {
    // 真实根因：表单发 requiresGit=null → 走 deleteIn 分支；dev 根本没有 requires 键，
    // deleteIn(['requires','git']) 会抛「Expected YAML collection」，deleteNestedSafe 兜住。
    const noReq = "name: d\nphases:\n  - name: a\n";
    expect(() => patchWorkflowMetaYaml(noReq, { requiresGit: null })).not.toThrow();
    expect(patchWorkflowMetaYaml(noReq, { requiresGit: null })).not.toContain("requires:");
    for (const bad of ["name: d\nrequires:\nphases:\n  - name: a\n", "name: d\nrequires: weird\nphases:\n  - name: a\n"]) {
      expect(() => patchWorkflowMetaYaml(bad, { requiresGit: null })).not.toThrow();
      expect(patchWorkflowMetaYaml(bad, { requiresGit: null })).not.toContain("requires:");
    }
  });

  it("undefined 字段完全不动 yaml", () => {
    const out = patchWorkflowMetaYaml(BASE, { label: "新名" });
    expect(out).not.toContain("requires:");
    expect(out).toMatch(/label:\s*新名/);
  });
});
