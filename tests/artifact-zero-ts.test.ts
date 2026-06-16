import { describe, it, expect } from "bun:test";
import { join } from "path";
import { existsSync } from "fs";
import { loadYamlWorkflow, type PhaseDefinition } from "../src/core/workflow/registry";

// 验证 artifact 工作流「零 ts」（P1）：produce=prompt-runner、deliver=框架内置交付器（deliver:artifacts），
// 无 workflow.ts、无 setup_func。delivers=artifacts 声明保留。
describe("artifact 工作流：零 ts（produce prompt + deliver 框架内置）", () => {
  const dir = join(import.meta.dir, "..", "examples", "workflows", "artifact");

  it("无 workflow.ts 文件", () => {
    expect(existsSync(join(dir, "workflow.ts"))).toBe(false);
  });

  it("加载成功且各 phase 绑定符合预期", async () => {
    const wf = await loadYamlWorkflow(dir);
    expect(wf).not.toBeNull();
    expect((wf as unknown as Record<string, unknown>).delivers).toBe("artifacts");
    expect(wf!.setup_func).toBeUndefined();

    const byName: Record<string, PhaseDefinition> = {};
    for (const p of wf!.phases) {
      if (!("parallel" in p)) byName[(p as PhaseDefinition).name] = p as PhaseDefinition;
    }
    // produce / deliver 都绑了函数、且不是「缺函数」抛错 stub
    for (const n of ["produce", "deliver"]) {
      expect(typeof byName[n].func).toBe("function");
      expect(byName[n].func!.toString()).not.toContain("未定义且未提供 prompt");
    }
    // deliver phase 声明 deliver: artifacts
    expect((byName["deliver"] as Record<string, unknown>)["deliver"]).toBe("artifacts");
  });
});
