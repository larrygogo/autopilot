/**
 * 产出形态 delivers 从 phases **自动派生**（registry deriveDelivers，2026-06-22）：
 * 顶层 delivers 不再由用户手填，而是从「哪个阶段有 deliver:」推断。通过 loadYamlWorkflow 端到端验证。
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadYamlWorkflow } from "../src/core/workflow/registry";

describe("delivers 从 phases 派生（deriveDelivers）", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = join(tmpdir(), `derive-delivers-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  async function load(yaml: string) {
    const dir = join(tmp, "wf");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "workflow.yaml"), yaml);
    return loadYamlWorkflow(dir);
  }

  it("无顶层 delivers + 有 deliver:pr 阶段 → 派生 pr", async () => {
    const w = await load(`name: wf
sandbox: { git: true }
phases:
  - name: dev
    prompt: 做开发
  - name: submit
    deliver: pr
`);
    expect(w?.delivers).toBe("pr");
  });

  it("无顶层 delivers + deliver:artifacts 阶段 → 派生 artifacts", async () => {
    const w = await load(`name: wf
phases:
  - name: produce
    prompt: 写到 \${DELIVERABLES}
  - name: deliver
    deliver: artifacts
`);
    expect(w?.delivers).toBe("artifacts");
  });

  it("顶层写了旧的 delivers:artifacts 但阶段是 deliver:pr → 派生覆盖成 pr（不再冲突报错）", async () => {
    const w = await load(`name: wf
delivers: artifacts
sandbox: { git: true }
phases:
  - name: dev
    prompt: x
  - name: submit
    deliver: pr
`);
    expect(w?.delivers).toBe("pr");
  });

  it("无任何 deliver 阶段 + yaml 显式 delivers:pr → 回退保留（ts 工作流兼容）", async () => {
    const w = await load(`name: wf
delivers: pr
sandbox: { git: true }
phases:
  - name: dev
    prompt: x
`);
    expect(w?.delivers).toBe("pr");
  });

  it("纯评审无 deliver 阶段 + 无显式 delivers → 不交付（delivers 空）", async () => {
    const w = await load(`name: wf
phases:
  - name: review
    prompt: 评审
`);
    expect(w?.delivers).toBeUndefined();
  });

  it("parallel 块内的 deliver 阶段也被收集派生", async () => {
    const w = await load(`name: wf
phases:
  - parallel:
      name: build
      phases:
        - name: fe
          prompt: x
        - name: deliver_fe
          deliver: artifacts
`);
    expect(w?.delivers).toBe("artifacts");
  });

  it("多个 deliver 阶段值不一致 → 加载失败（一个工作流只能产一种形态）", async () => {
    await expect(
      load(`name: wf
phases:
  - name: a
    deliver: pr
  - name: b
    deliver: artifacts
`),
    ).rejects.toThrow(/多种交付形态|只能产出一种/);
  });
});
