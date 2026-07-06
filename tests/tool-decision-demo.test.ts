/**
 * tool_decision_demo 示例集成缝：yaml 可加载 + decision lint 放行 mode:tool +
 * reject 派生的转换在表里真实存在 + planDecisionActionFromVerdict 喂真实 meta 自洽。
 * 完整 runner+agent 的 tool 裁决回路靠真任务 dogfood 验（同 review_loop 测试哲学）。
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadJsonWorkflow,
  buildTransitions,
  _clearRegistry,
  type WorkflowDefinition,
  type PhaseDefinition,
} from "../src/core/workflow/registry";
import { planDecisionActionFromVerdict } from "../src/core/workflow/phase-decision";

const EXAMPLE_DIR = join(import.meta.dir, "..", "examples", "workflows", "tool_decision_demo");

let tmpHome: string;
let wf: WorkflowDefinition;
let review: PhaseDefinition;

beforeEach(async () => {
  tmpHome = join(tmpdir(), `autopilot-tooldemo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "workflows"), { recursive: true });
  process.env.AUTOPILOT_HOME = tmpHome;
  _clearRegistry();
  const loaded = await loadJsonWorkflow(EXAMPLE_DIR);
  if (!loaded) throw new Error("tool_decision_demo 示例加载失败");
  wf = loaded;
  review = wf.phases.find((p) => !("parallel" in p) && (p as PhaseDefinition).name === "review") as PhaseDefinition;
});

afterEach(() => {
  delete process.env.AUTOPILOT_HOME;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe("tool_decision_demo 可加载 + decision mode:tool 就位", () => {
  it("yaml 加载成功（lint 放行 mode:tool，无需 pass/reject 标记）", () => {
    expect(wf.name).toBe("tool_decision_demo");
    expect(wf.phases.length).toBe(2);
  });

  it("review phase = decision mode:tool + reject 派生的 jump 元信息", () => {
    expect(review.decision).toMatchObject({ mode: "tool" });
    expect((review.decision as { pass?: string }).pass).toBeUndefined(); // tool 模式不写标记
    expect(review.jump_trigger).toBe("review_reject");
    expect(review.jump_target).toBe("design");
    expect(review.max_rejections).toBe(3);
  });

  it("design phase 是 prompt 模式（绑定了 func，非抛错 stub）", () => {
    const design = wf.phases.find((p) => (p as PhaseDefinition).name === "design") as PhaseDefinition;
    expect(typeof design.func).toBe("function");
  });
});

describe("tool 裁决驱动的 trigger 在转换表里真实存在", () => {
  it("running_review --review_reject--> review_rejected --retry_design--> pending_design", () => {
    const t = buildTransitions(wf);
    const fromRunning = t["running_review"] ?? [];
    expect(fromRunning.some(([trig]) => trig === "review_complete")).toBe(true); // pass 靠 runner 自动推进
    const rejected = fromRunning.find(([trig]) => trig === "review_reject")?.[1];
    expect(rejected).toBe("review_rejected");
    const retry = (t["review_rejected"] ?? []).find(([trig]) => trig === "retry_design");
    expect(retry?.[1]).toBe("pending_design");
  });
});

describe("planDecisionActionFromVerdict × review 真实 meta → 三路径自洽（tool 复用同一后半段）", () => {
  const meta = () => ({
    jumpTrigger: review.jump_trigger,
    jumpTarget: review.jump_target,
    maxRejections: review.max_rejections,
  });

  it("pass → kind:pass（落空，runner 自动 complete）", () => {
    expect(planDecisionActionFromVerdict({ verdict: "pass" }, "review", meta(), {})).toEqual({ kind: "pass" });
  });

  it("reject 首次 → retry，retryTrigger 在转换表里存在", () => {
    const a = planDecisionActionFromVerdict({ verdict: "reject", reason: "缺测试" }, "review", meta(), {});
    expect(a.kind).toBe("retry");
    if (a.kind === "retry") {
      expect(a.jumpTrigger).toBe("review_reject");
      expect(a.retryTrigger).toBe("retry_design");
      expect(a.reason).toBe("缺测试");
    }
  });

  it("reject 触顶（已驳 2 次，max=3）→ fail", () => {
    const a = planDecisionActionFromVerdict({ verdict: "reject", reason: "还是不行" }, "review", meta(), { review: 2 });
    expect(a).toMatchObject({ kind: "fail", n: 3, maxRejections: 3 });
  });
});
