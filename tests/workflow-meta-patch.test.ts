/**
 * patchWorkflowMetaYaml 声明层（v2 R5）：requires.git / sandbox.git / delivers
 * 的写键 / 删键 / 空 map 清理，且保留注释与其他段。纯函数单测。
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

describe("patchWorkflowMetaYaml 声明层", () => {
  it("requires.git：显式值写键，null 删键并清空 requires 壳", () => {
    const set = patchWorkflowMetaYaml(BASE, { requiresGit: "optional" });
    expect(set).toContain("requires:");
    expect(set).toMatch(/git:\s*optional/);

    const cleared = patchWorkflowMetaYaml(set, { requiresGit: null });
    expect(cleared).not.toContain("requires:");
  });

  it("requires.git=false 是有意义的显式值（不删键）", () => {
    const out = patchWorkflowMetaYaml(BASE, { requiresGit: false });
    expect(out).toMatch(/requires:/);
    expect(out).toMatch(/git:\s*false/);
  });

  it("sandbox.git：true 写键，false/null 删键并清空 sandbox 壳", () => {
    const on = patchWorkflowMetaYaml(BASE, { sandboxGit: true });
    expect(on).toMatch(/sandbox:/);
    expect(on).toMatch(/git:\s*true/);

    expect(patchWorkflowMetaYaml(on, { sandboxGit: false })).not.toContain("sandbox:");
    expect(patchWorkflowMetaYaml(on, { sandboxGit: null })).not.toContain("sandbox:");
  });

  it("sandbox 段含其他键时，删 git 不误删整段", () => {
    const withTemplate = `name: demo
sandbox:
  git: true
  template: ws_tpl
phases:
  - name: step1
`;
    const out = patchWorkflowMetaYaml(withTemplate, { sandboxGit: false });
    expect(out).toMatch(/sandbox:/);
    expect(out).toMatch(/template:\s*ws_tpl/);
    expect(out).not.toMatch(/git:\s*true/);
  });

  it("delivers：写顶层键，null/空串删键", () => {
    const pr = patchWorkflowMetaYaml(BASE, { delivers: "pr" });
    expect(pr).toMatch(/delivers:\s*pr/);
    expect(patchWorkflowMetaYaml(pr, { delivers: null })).not.toContain("delivers:");
    expect(patchWorkflowMetaYaml(pr, { delivers: "" })).not.toContain("delivers:");
  });

  it("保留注释与无关段（phases / 注释不动）", () => {
    const out = patchWorkflowMetaYaml(BASE, { requiresGit: true, delivers: "pr" });
    expect(out).toContain("# 这是阶段段的注释，应被保留");
    expect(out).toMatch(/phases:/);
    expect(out).toMatch(/step1/);
  });

  it("容错：requires 为 null 标量 / 字符串（被写坏状态）→ setIn 不抛，整体替换成 map", () => {
    // 复现用户报的 SAVE_FAILED「Expected YAML collection at requires. Remaining path: git」
    for (const bad of ["name: d\nrequires:\nphases:\n  - name: a\n", "name: d\nrequires: optional\nphases:\n  - name: a\n"]) {
      const out = patchWorkflowMetaYaml(bad, { requiresGit: true });
      expect(out).toMatch(/requires:\s*\n\s+git:\s*true/);
    }
    // sandbox 同理
    const out = patchWorkflowMetaYaml("name: d\nsandbox:\nphases:\n  - name: a\n", { sandboxGit: true });
    expect(out).toMatch(/sandbox:\s*\n\s+git:\s*true/);
  });

  it("容错：删 requires.git（requiresGit=null）时 requires 缺失 / 非 map 也不抛", () => {
    // 真实根因：表单「跟随默认」发 requiresGit=null → 走 deleteIn 分支。
    // dev 根本没有 requires 键，deleteIn(['requires','git']) 同样抛「Expected YAML collection」。
    // ① requires 完全缺失（dev 的真实形态）
    const noReq = "name: d\nsandbox:\n  git: true\nphases:\n  - name: a\n";
    expect(() => patchWorkflowMetaYaml(noReq, { requiresGit: null })).not.toThrow();
    expect(patchWorkflowMetaYaml(noReq, { requiresGit: null })).not.toContain("requires:");
    // ② requires 是 null 标量 / 字符串坏状态 → 删键不抛、整段清掉
    for (const bad of ["name: d\nrequires:\nphases:\n  - name: a\n", "name: d\nrequires: optional\nphases:\n  - name: a\n"]) {
      expect(() => patchWorkflowMetaYaml(bad, { requiresGit: null })).not.toThrow();
      expect(patchWorkflowMetaYaml(bad, { requiresGit: null })).not.toContain("requires:");
    }
    // ③ sandbox 同理（sandboxGit=false/null 删键）
    expect(() => patchWorkflowMetaYaml("name: d\nsandbox: weird\nphases:\n  - name: a\n", { sandboxGit: false })).not.toThrow();
    // ④ 用户的完整表单组合（跟随默认 + 建沙盒 + 文件产出）一次过
    const full = patchWorkflowMetaYaml(noReq, { requiresGit: null, sandboxGit: true, delivers: "artifacts" });
    expect(full).toMatch(/delivers:\s*artifacts/);
    expect(full).toMatch(/git:\s*true/);
  });

  it("undefined 字段完全不动 yaml", () => {
    const out = patchWorkflowMetaYaml(BASE, { label: "新名" });
    expect(out).not.toContain("requires:");
    expect(out).not.toContain("sandbox:");
    expect(out).not.toContain("delivers:");
    expect(out).toMatch(/label:\s*新名/);
  });
});
