/**
 * 结构化裁判 judgeVerdict（声明式工作流砖 2）。
 * 用注入的假结构化调用（judgeVerdictWith），不碰全局 mock.module（避免污染其它测试）。
 * 验证：verdict 收敛 / 重试一次 / 失败→ambiguous（不退回 grep）。
 */
import { describe, it, expect } from "bun:test";
import { judgeVerdictWith, type StructuredFn } from "../src/core/judge";

/** 把"返回值/抛错"序列包装成 StructuredFn。 */
function seq(...steps: Array<{ ret?: { verdict?: string; reason?: string }; err?: string }>): {
  fn: StructuredFn;
  calls: () => number;
} {
  let i = 0;
  const fn = (async () => {
    const step = steps[Math.min(i, steps.length - 1)];
    i++;
    if (step.err) throw new Error(step.err);
    return step.ret ?? {};
  }) as StructuredFn;
  return { fn, calls: () => i };
}

describe("judgeVerdictWith", () => {
  it("verdict=pass → {verdict:pass}", async () => {
    const { fn } = seq({ ret: { verdict: "pass", reason: "一切良好" } });
    expect(await judgeVerdictWith(fn, { review: "代码不错" })).toEqual({ verdict: "pass" });
  });

  it("verdict=reject → 带 reason", async () => {
    const { fn } = seq({ ret: { verdict: "reject", reason: "缺测试覆盖" } });
    expect(await judgeVerdictWith(fn, { review: "...", criteria: "需有测试" })).toEqual({
      verdict: "reject",
      reason: "缺测试覆盖",
    });
  });

  it("reject 但 reason 空 → 兜底文案", async () => {
    const { fn } = seq({ ret: { verdict: "reject", reason: "" } });
    const r = await judgeVerdictWith(fn, { review: "x" });
    expect(r).toMatchObject({ verdict: "reject" });
    if (r.verdict === "reject") expect(r.reason).toContain("未给理由");
  });

  it("大小写 / 空格不敏感（PASS / ' reject '）", async () => {
    expect((await judgeVerdictWith(seq({ ret: { verdict: "PASS" } }).fn, { review: "x" })).verdict).toBe("pass");
    expect((await judgeVerdictWith(seq({ ret: { verdict: " reject ", reason: "r" } }).fn, { review: "x" })).verdict).toBe("reject");
  });

  it("第一次抛错、第二次成功 → 重试拿到结论", async () => {
    const { fn, calls } = seq({ err: "provider 抖动" }, { ret: { verdict: "pass", reason: "ok" } });
    expect((await judgeVerdictWith(fn, { review: "x" })).verdict).toBe("pass");
    expect(calls()).toBe(2);
  });

  it("两次都抛错 → ambiguous（停下报人，不退回 grep）", async () => {
    const { fn } = seq({ err: "缺 API key" });
    expect(await judgeVerdictWith(fn, { review: "x" })).toEqual({ verdict: "ambiguous" });
  });

  it("verdict 非法值两次 → ambiguous", async () => {
    const { fn } = seq({ ret: { verdict: "maybe", reason: "?" } });
    expect(await judgeVerdictWith(fn, { review: "x" })).toEqual({ verdict: "ambiguous" });
  });
});
