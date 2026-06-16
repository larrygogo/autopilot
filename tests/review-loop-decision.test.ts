/**
 * review_loop 示例集成测试：把「示例工作流 + 纯判据逻辑 + 真实转换表」三者钉在一起。
 *
 * 不跑完整 runner + agent（纯逻辑已在 phase-decision.test.ts 全覆盖；executor 是 thin I/O，
 * 用的是 dev workflow 同款经生产验证的 transition 调用）。这里验证真正的集成缝：
 *   - 示例 yaml 可加载、decision lint 放行
 *   - executor 会调的 trigger（review_reject / retry_design / review_complete）在转换表里真实存在且路由正确
 *   - planDecisionAction 喂 review phase 的真实 meta → pass/reject/触顶 三路径产出的动作与转换表自洽
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadYamlWorkflow,
  buildTransitions,
  _clearRegistry,
  type WorkflowDefinition,
  type PhaseDefinition,
} from "../src/core/workflow/registry";
import { planDecisionAction } from "../src/core/workflow/phase-decision";

const EXAMPLE_DIR = join(import.meta.dir, "..", "examples", "workflows", "review_loop");

let tmpHome: string;
let wf: WorkflowDefinition;
let review: PhaseDefinition;

beforeEach(async () => {
  tmpHome = join(tmpdir(), `autopilot-reviewloop-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "workflows"), { recursive: true });
  process.env.AUTOPILOT_HOME = tmpHome;
  _clearRegistry();
  const loaded = await loadYamlWorkflow(EXAMPLE_DIR);
  if (!loaded) throw new Error("review_loop 示例加载失败");
  wf = loaded;
  review = wf.phases.find((p) => !("parallel" in p) && (p as PhaseDefinition).name === "review") as PhaseDefinition;
});

afterEach(() => {
  delete process.env.AUTOPILOT_HOME;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe("review_loop 示例可加载 + decision 就位", () => {
  it("yaml 加载成功（decision lint 放行合法配置）", () => {
    expect(wf.name).toBe("review_loop");
    expect(wf.phases.length).toBe(2);
  });

  it("review phase 带 decision + reject 派生的 jump 元信息", () => {
    expect(review.decision).toMatchObject({ pass: "REVIEW_RESULT: PASS", reject: "REVIEW_RESULT: REJECT" });
    expect(review.jump_trigger).toBe("review_reject");
    expect(review.jump_target).toBe("design");
    expect(review.max_rejections).toBe(3);
  });

  it("design phase 是 prompt 模式（绑定了 func，非抛错 stub）", () => {
    const design = wf.phases.find((p) => (p as PhaseDefinition).name === "design") as PhaseDefinition;
    expect(typeof design.func).toBe("function");
  });
});

describe("executor 会调的 trigger 在转换表里真实存在且路由正确", () => {
  it("running_review --review_complete--> 推进；--review_reject--> review_rejected --retry_design--> pending_design", () => {
    const t = buildTransitions(wf);
    const fromRunning = t["running_review"] ?? [];
    const triggers = fromRunning.map(([trig]) => trig);
    expect(triggers).toContain("review_complete"); // pass 路径靠 runner 自动推进
    expect(triggers).toContain("review_reject");   // reject 路径 executor 第一跳

    const rejected = fromRunning.find(([trig]) => trig === "review_reject")?.[1];
    expect(rejected).toBe("review_rejected");

    const fromRejected = t["review_rejected"] ?? [];
    const retry = fromRejected.find(([trig]) => trig === "retry_design");
    expect(retry).toBeDefined();
    expect(retry![1]).toBe("pending_design"); // executor 第二跳落回 design 重做
  });
});

describe("planDecisionAction × review 真实 meta → 三路径自洽", () => {
  const meta = () => ({
    jumpTrigger: review.jump_trigger,
    jumpTarget: review.jump_target,
    maxRejections: review.max_rejections,
  });

  it("PASS → pass（落空，靠 runner 自动 complete）", () => {
    const a = planDecisionAction("一切良好\nREVIEW_RESULT: PASS", review.decision!, "review", meta(), {});
    expect(a).toEqual({ kind: "pass" });
  });

  it("REJECT 首次 → retry，且 retryTrigger 在转换表里存在", () => {
    const out = "REVIEW_RESULT: REJECT\n## 驳回理由\n缺测试计划";
    const a = planDecisionAction(out, review.decision!, "review", meta(), {});
    expect(a.kind).toBe("retry");
    if (a.kind === "retry") {
      expect(a.jumpTrigger).toBe("review_reject");
      expect(a.retryTrigger).toBe("retry_design");
      expect(a.reason).toBe("缺测试计划");
      const t = buildTransitions(wf);
      expect((t["running_review"] ?? []).some(([trig]) => trig === a.jumpTrigger)).toBe(true);
      expect((t["review_rejected"] ?? []).some(([trig]) => trig === a.retryTrigger)).toBe(true);
    }
  });

  it("REJECT 触顶（已驳 2 次，max=3）→ fail", () => {
    const out = "REVIEW_RESULT: REJECT\n## 驳回理由\n还是不行";
    const a = planDecisionAction(out, review.decision!, "review", meta(), { review: 2 });
    expect(a).toMatchObject({ kind: "fail", n: 3, maxRejections: 3 });
  });
});
