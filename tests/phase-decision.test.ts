import { describe, it, expect } from "bun:test";
import {
  evaluatePhaseDecision,
  extractMarkdownSection,
  planDecisionAction,
  planDecisionActionFromVerdict,
  type PhaseDecision,
} from "../src/core/workflow/phase-decision";

const D: PhaseDecision = { pass: "RESULT: PASS", reject: "RESULT: REJECT", reason_section: "## 驳回理由" };

describe("evaluatePhaseDecision", () => {
  it("pass 命中", () => {
    expect(evaluatePhaseDecision("一切良好\nRESULT: PASS", D)).toEqual({ verdict: "pass" });
  });
  it("reject 命中 → 抽 reason_section", () => {
    const out = "评审\nRESULT: REJECT\n## 驳回理由\n缺测试覆盖\n## 其他\nx";
    expect(evaluatePhaseDecision(out, D)).toEqual({ verdict: "reject", reason: "缺测试覆盖" });
  });
  it("reject 优先于 pass（两词都出现）", () => {
    const out = "RESULT: PASS 但其实 RESULT: REJECT\n## 驳回理由\n有坑";
    expect(evaluatePhaseDecision(out, D).verdict).toBe("reject");
  });
  it("reason_section 缺失 → 取全文截断", () => {
    const out = "RESULT: REJECT 没写理由段";
    const r = evaluatePhaseDecision(out, D);
    expect(r.verdict).toBe("reject");
    if (r.verdict === "reject") expect(r.reason).toContain("没写理由");
  });
  it("都不命中 → ambiguous", () => {
    expect(evaluatePhaseDecision("模型没按格式输出", D)).toEqual({ verdict: "ambiguous" });
  });
  it("match=regex", () => {
    const dr: PhaseDecision = { pass: "通过|PASS", reject: "驳回|REJECT", match: "regex" };
    expect(evaluatePhaseDecision("结论：通过", dr).verdict).toBe("pass");
  });
});

describe("extractMarkdownSection", () => {
  it("抽指定二级标题段到下一个 ## 前", () => {
    expect(extractMarkdownSection("## A\n1\n2\n## B\n3", "## A")).toBe("1\n2");
  });
  it("无该段返回 null", () => {
    expect(extractMarkdownSection("## A\n1", "## Z")).toBeNull();
  });
});

describe("planDecisionAction", () => {
  const meta = { jumpTrigger: "review_reject", jumpTarget: "design", maxRejections: 3 };
  it("pass → kind pass", () => {
    expect(planDecisionAction("RESULT: PASS", D, "review", meta, {})).toEqual({ kind: "pass" });
  });
  it("ambiguous → kind ambiguous", () => {
    expect(planDecisionAction("乱输出", D, "review", meta, {}).kind).toBe("ambiguous");
  });
  it("reject 未触顶 → retry，计数 +1", () => {
    const a = planDecisionAction("RESULT: REJECT\n## 驳回理由\nx", D, "review", meta, { review: 1 });
    expect(a).toMatchObject({ kind: "retry", jumpTrigger: "review_reject", retryTrigger: "retry_design", target: "design", n: 2 });
    if (a.kind === "retry") expect(a.counts.review).toBe(2);
  });
  it("reject 触顶（n≥max）→ fail", () => {
    const a = planDecisionAction("RESULT: REJECT\n## 驳回理由\nx", D, "review", meta, { review: 2 });
    expect(a).toMatchObject({ kind: "fail", n: 3, maxRejections: 3 });
  });
  it("reject 但无 jump 目标 → misconfigured", () => {
    const a = planDecisionAction("RESULT: REJECT", D, "review", { maxRejections: 10 }, {});
    expect(a.kind).toBe("misconfigured");
  });
});

describe("planDecisionActionFromVerdict（marker / tool 共用后半段）", () => {
  const meta = { jumpTrigger: "review_reject", jumpTarget: "design", maxRejections: 3 };
  it("pass verdict → kind pass", () => {
    expect(planDecisionActionFromVerdict({ verdict: "pass" }, "review", meta, {})).toEqual({ kind: "pass" });
  });
  it("ambiguous verdict → kind ambiguous", () => {
    expect(planDecisionActionFromVerdict({ verdict: "ambiguous" }, "review", meta, {}).kind).toBe("ambiguous");
  });
  it("reject verdict 未触顶 → retry 计数 +1", () => {
    const a = planDecisionActionFromVerdict({ verdict: "reject", reason: "缺测试" }, "review", meta, { review: 1 });
    expect(a).toMatchObject({ kind: "retry", target: "design", n: 2, reason: "缺测试" });
  });
  it("reject verdict 触顶 → fail", () => {
    const a = planDecisionActionFromVerdict({ verdict: "reject", reason: "x" }, "review", meta, { review: 2 });
    expect(a).toMatchObject({ kind: "fail", n: 3, maxRejections: 3 });
  });
  it("reject verdict 无 jump 目标 → misconfigured", () => {
    const a = planDecisionActionFromVerdict({ verdict: "reject", reason: "x" }, "review", { maxRejections: 10 }, {});
    expect(a.kind).toBe("misconfigured");
  });
});
