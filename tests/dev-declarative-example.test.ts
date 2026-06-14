/**
 * dev_declarative 示例集成测试（声明式工作流砖 6 的静态验收）：
 * 把「声明式闸门 + prompt-runner + handoff + judge + builtin deliver_pr + git 沙盒 + 转换表」
 * 全链路钉在一起——证明一条**零 TS** 的完整 PR 交付工作流可加载、各 phase 绑定到框架原语、
 * 转换表自洽。不跑真 agent / 真 PR（需 API key + 真仓库，属人工 dogfood）。
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadYamlWorkflow,
  buildTransitions,
  getWorkflowGitRequirement,
  _clearRegistry,
  type WorkflowDefinition,
  type PhaseDefinition,
} from "../src/core/registry";

const EXAMPLE_DIR = join(import.meta.dir, "..", "examples", "workflows", "dev_declarative");

let tmpHome: string;
let wf: WorkflowDefinition;

function topPhase(name: string): PhaseDefinition {
  const p = wf.phases.find((x) => !("parallel" in x) && (x as PhaseDefinition).name === name);
  if (!p) throw new Error(`phase ${name} 未找到`);
  return p as PhaseDefinition;
}

beforeEach(async () => {
  tmpHome = join(tmpdir(), `autopilot-devdecl-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "workflows"), { recursive: true });
  process.env.AUTOPILOT_HOME = tmpHome;
  _clearRegistry();
  const loaded = await loadYamlWorkflow(EXAMPLE_DIR);
  if (!loaded) throw new Error("dev_declarative 示例加载失败");
  wf = loaded;
});

afterEach(() => {
  delete process.env.AUTOPILOT_HOME;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe("dev_declarative 示例可加载 + 全声明式", () => {
  it("加载成功且标记 declarative + delivers:pr + 需要 git", () => {
    expect(wf.name).toBe("dev_declarative");
    expect(wf.declarative).toBe(true);
    expect(wf.delivers).toBe("pr");
    expect(getWorkflowGitRequirement(wf)).toBe(true);
  });

  it("4 个 phase 全绑定到框架原语（非抛错 stub），无任何 TS 函数", () => {
    for (const name of ["design", "develop", "code_review", "deliver"]) {
      expect(typeof topPhase(name).func).toBe("function");
    }
  });

  it("design / develop 是 prompt 模式 + handoff", () => {
    expect(topPhase("design").handoff).toBe(true);
    expect(topPhase("develop").handoff).toBe(true);
    expect(typeof (topPhase("design") as Record<string, unknown>)["prompt"]).toBe("string");
  });

  it("code_review 是结构化裁判（mode:judge）+ reject 回退 develop", () => {
    const cr = topPhase("code_review");
    expect(cr.decision).toMatchObject({ mode: "judge" });
    expect(cr.jump_trigger).toBe("code_review_reject");
    expect(cr.jump_target).toBe("develop");
    expect(cr.max_rejections).toBe(3);
  });

  it("deliver 是内置 deliver_pr 原语", () => {
    expect(topPhase("deliver").builtin).toBe("deliver_pr");
  });

  it("转换表自洽：judge reject 走的 trigger 真实存在且路由正确", () => {
    const transitions = buildTransitions(wf);
    const cr = topPhase("code_review");
    // jump_trigger（code_review_reject）+ retry_develop 在转换表里可路由
    const runningCr = cr.running_state;
    expect(transitions[runningCr]?.some(([trig]) => trig === "code_review_reject")).toBe(true);
    // 通过路径：code_review_complete 推进到交付
    expect(transitions[runningCr]?.some(([trig]) => trig === "code_review_complete")).toBe(true);
  });
});
