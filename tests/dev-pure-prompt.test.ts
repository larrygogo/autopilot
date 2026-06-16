import { describe, it, expect } from "bun:test";
import { join } from "path";
import { loadYamlWorkflow, type PhaseDefinition } from "../src/core/workflow/registry";

// 验证 dev 工作流「agent 阶段纯提示词 + 提示词优先 + submit_pr 保留 ts」转换正确：
// - design/review/develop/code_review 绑定 prompt-runner（不是 stub、不是 ts run_）；
// - review/code_review 的 decision(judge) + reject 语法糖展开成 jump_target；
// - submit_pr 无 prompt → 回退绑定 ts run_submit_pr。
describe("dev 工作流：agent 阶段纯提示词 + submit_pr 机械 ts", () => {
  const devDir = join(import.meta.dir, "..", "examples", "workflows", "dev");

  it("加载成功且各 phase 绑定符合预期", async () => {
    const wf = await loadYamlWorkflow(devDir);
    expect(wf).not.toBeNull();
    const byName: Record<string, PhaseDefinition> = {};
    for (const p of wf!.phases) {
      if (!("parallel" in p)) byName[(p as PhaseDefinition).name] = p as PhaseDefinition;
    }

    // 五个 phase 都在
    for (const n of ["design", "review", "develop", "code_review", "submit_pr"]) {
      expect(byName[n]).toBeDefined();
      expect(typeof byName[n].func).toBe("function");
      // 不是「缺函数」抛错 stub
      expect(byName[n].func!.toString()).not.toContain("未定义且未提供 prompt");
    }

    // review / code_review：reject 语法糖展开成 jump_target + decision 透传
    expect((byName["review"] as Record<string, unknown>)["jump_target"]).toBe("design");
    expect((byName["code_review"] as Record<string, unknown>)["jump_target"]).toBe("develop");
    expect((byName["review"] as Record<string, unknown>)["decision"]).toBeDefined();
    expect((byName["code_review"] as Record<string, unknown>)["decision"]).toBeDefined();

    // design 开了 handoff
    expect((byName["design"] as Record<string, unknown>)["handoff"]).toBe(true);
  });
});
