/**
 * 需求卡片按状态特义化的纯函数测试。
 * spec: docs/superpowers/specs/2026-06-10-requirement-card-status-specialization-design.md
 */
import { describe, it, expect } from "bun:test";
import { reqCardSpec, specPreview, type ReqCardInput } from "../src/web/src/lib/requirement-card";

const base: ReqCardInput = {
  status: "drafting",
  spec_md: "",
  task_id: null,
  pr_url: null,
  active_question_id: null,
  clarifier_error: null,
  schedule_error: null,
};

const keysOf = (input: ReqCardInput) => reqCardSpec(input).actions.map((a) => a.key);

describe("reqCardSpec", () => {
  it("drafting：有 spec 时露摘要，无动作", () => {
    const r = reqCardSpec({ ...base, spec_md: "# 标题\n\n做个东西" });
    expect(r.preview).toContain("做个东西");
    expect(r.actions).toEqual([]);
    expect(r.notice).toBe(null);
  });

  it("clarifying：有待回答问题 → info 提示 + 去回答", () => {
    const r = reqCardSpec({ ...base, status: "clarifying", active_question_id: "qst-001" });
    expect(r.notice?.tone).toBe("info");
    expect(keysOf({ ...base, status: "clarifying", active_question_id: "qst-001" })).toEqual(["answer"]);
  });

  it("clarifying：clarifier_error → 错误摘要 + 重试澄清", () => {
    const input = { ...base, status: "clarifying", clarifier_error: "LLM 超时" };
    const r = reqCardSpec(input);
    expect(r.notice?.tone).toBe("error");
    expect(r.notice?.text).toContain("LLM 超时");
    expect(keysOf(input)).toEqual(["retryClarify"]);
  });

  it("ready：无 error 时无动作；schedule_error → 错误摘要 + 重新入队", () => {
    expect(keysOf({ ...base, status: "ready" })).toEqual([]);
    const input = { ...base, status: "ready", schedule_error: "workspace 不可用" };
    const r = reqCardSpec(input);
    expect(r.notice?.tone).toBe("error");
    expect(keysOf(input)).toEqual(["retry"]);
  });

  it("awaiting_approval：spec 摘要 + 通过/驳回", () => {
    const input = { ...base, status: "awaiting_approval", spec_md: "## 摘要\n改 StepBar" };
    const r = reqCardSpec(input);
    expect(r.preview).toContain("改 StepBar");
    expect(keysOf(input)).toEqual(["approve", "reject"]);
  });

  it("queued：排队提示，无动作", () => {
    const r = reqCardSpec({ ...base, status: "queued" });
    expect(r.notice?.tone).toBe("info");
    expect(r.actions).toEqual([]);
  });

  it("running / fix_revision：有 task_id 时给看执行", () => {
    expect(keysOf({ ...base, status: "running", task_id: "abc12345" })).toEqual(["viewTask"]);
    expect(keysOf({ ...base, status: "fix_revision", task_id: "abc12345" })).toEqual(["viewTask"]);
    expect(keysOf({ ...base, status: "running" })).toEqual([]); // 无 task_id 不给
  });

  it("awaiting_review / done：有 pr_url 时给打开 PR", () => {
    expect(keysOf({ ...base, status: "awaiting_review", pr_url: "https://x/pr/1" })).toEqual(["openPr"]);
    expect(keysOf({ ...base, status: "done", pr_url: "https://x/pr/1" })).toEqual(["openPr"]);
    expect(keysOf({ ...base, status: "done" })).toEqual([]);
  });

  it("failed：失败原因（status_reason 优先于 schedule_error / clarifier_error）+ 重试", () => {
    const input = { ...base, status: "failed", schedule_error: "调度炸了", clarifier_error: "别显示我" };
    const r = reqCardSpec(input);
    expect(r.notice?.tone).toBe("error");
    expect(r.notice?.text).toContain("调度炸了");
    expect(keysOf(input)).toEqual(["retry"]);

    const withReason = { ...input, status_reason: "develop 阶段崩溃", status_reason_source: "task" as const };
    expect(reqCardSpec(withReason).notice?.text).toContain("develop 阶段崩溃");
  });

  it("cancelled：手动取消无特化", () => {
    const r = reqCardSpec({ ...base, status: "cancelled" });
    expect(r.preview).toBe(null);
    expect(r.notice).toBe(null);
    expect(r.actions).toEqual([]);
    // user 来源的原因也不向用户解释他自己的操作
    const manual = reqCardSpec({ ...base, status: "cancelled", status_reason: "用户手动取消", status_reason_source: "user" });
    expect(manual.notice).toBe(null);
  });

  it("cancelled：task 级联（自动止损）露原因 + 看原因下钻", () => {
    const input: ReqCardInput = {
      ...base,
      status: "cancelled",
      task_id: "h2wznnwg",
      status_reason: "代码审查驳回 3 次，已取消",
      status_reason_source: "task",
    };
    const r = reqCardSpec(input);
    expect(r.notice?.tone).toBe("info");
    expect(r.notice?.text).toContain("代码审查驳回 3 次");
    expect(keysOf(input)).toEqual(["viewTask"]);
    // 无 task_id（system 取消）时只露原因不给下钻
    expect(keysOf({ ...input, task_id: null })).toEqual([]);
  });
});

describe("specPreview", () => {
  it("去掉 markdown 标题符并截断", () => {
    expect(specPreview("# 大标题\n\n## 小标题\n正文内容")).toBe("大标题 小标题 正文内容");
    expect(specPreview("")).toBe(null);
    expect(specPreview("   \n  ")).toBe(null);
  });
  it("超长截断到 120 字符 + 省略号", () => {
    const long = "x".repeat(200);
    const p = specPreview(long)!;
    expect(p.length).toBe(121); // 120 + …
    expect(p.endsWith("…")).toBe(true);
  });
});
