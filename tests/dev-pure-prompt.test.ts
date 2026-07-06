import { describe, it, expect } from "bun:test";
import { join } from "path";
import { loadJsonWorkflow, type PhaseDefinition } from "../src/core/workflow/registry";

// 验证 dev 工作流「agent 阶段纯提示词 + 提示词优先 + submit_pr 框架内置 PR 交付」转换正确：
// - design/review/develop/code_review 绑定 prompt-runner（不是 stub、不是 ts run_）；
// - review/code_review 的 decision(mode:tool) + reject 语法糖展开成 jump_target；
// - submit_pr 声明 deliver:pr → 绑框架内置 PR 交付器（Step4 收编，零 ts，不再有 run_submit_pr）。
describe("dev 工作流：agent 阶段纯提示词 + submit_pr 框架内置 PR 交付", () => {
  const devDir = join(import.meta.dir, "..", "examples", "workflows", "dev");

  it("加载成功且各 phase 绑定符合预期", async () => {
    const wf = await loadJsonWorkflow(devDir);
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
    // decision 已从 judge 迁到 tool（做评审的 agent 自己调 submit_decision，不另起裁判 LLM）
    const reviewDec = (byName["review"] as Record<string, unknown>)["decision"] as Record<string, unknown>;
    const codeReviewDec = (byName["code_review"] as Record<string, unknown>)["decision"] as Record<string, unknown>;
    expect(reviewDec).toBeDefined();
    expect(reviewDec["mode"]).toBe("tool");
    expect(reviewDec["judge_provider"]).toBeUndefined(); // judge 字段已移除
    expect(typeof reviewDec["criteria"]).toBe("string");   // 判据保留（${CRITERIA} 注入到评审 prompt）
    expect(codeReviewDec).toBeDefined();
    expect(codeReviewDec["mode"]).toBe("tool");
    expect(codeReviewDec["judge_provider"]).toBeUndefined();

    // design 开了 handoff
    expect((byName["design"] as Record<string, unknown>)["handoff"]).toBe(true);

    // submit_pr 声明 deliver:pr（Step4：spawn 交付收编进框架，dev 不再带 run_submit_pr ts）
    expect((byName["submit_pr"] as Record<string, unknown>)["deliver"]).toBe("pr");
    expect((byName["submit_pr"] as Record<string, unknown>)["pr_body_from"]).toBe("design");
  });
});
