/**
 * GA 式执行视图（TaskRunView）纯逻辑测试。
 * spec: docs/superpowers/specs/2026-06-10-project-pipeline-list-and-ga-task-view-design.md（B5 交互规格）
 */
import { describe, it, expect } from "bun:test";
import {
  createExpandState, applyStatusTransitions, toggleManual, isExpanded,
  shouldFollow, resolveLogPhase, phaseRounds, fmtDuration,
  LEVEL_RE, extractLevel, isNeverRun,
  type ExpandState, type PhaseRunState,
} from "../src/web/src/lib/run-view-logic";

const S = (statuses: Record<string, PhaseRunState>, prev?: ExpandState) =>
  applyStatusTransitions(prev ?? createExpandState(), statuses);

describe("展开状态机（spec B5）", () => {
  it("pending→running 跃迁自动展开", () => {
    let st = S({ dev: "pending" });
    expect(isExpanded(st, "dev")).toBe(false);
    st = S({ dev: "running" }, st);
    expect(isExpanded(st, "dev")).toBe(true);
  });
  it("手动收起 running 后当前周期不再自动展开", () => {
    let st = S({ dev: "running" });
    st = toggleManual(st, "dev"); // 收起
    expect(isExpanded(st, "dev")).toBe(false);
    st = S({ dev: "running" }, st); // 同状态重复 apply（轮询）
    expect(isExpanded(st, "dev")).toBe(false);
  });
  it("状态跃迁清除 override；→failed 强制展开覆盖手动收起", () => {
    let st = S({ dev: "running" });
    st = toggleManual(st, "dev"); // 用户收起
    st = S({ dev: "failed" }, st); // 跃迁 failed
    expect(isExpanded(st, "dev")).toBe(true);
  });
  it("→awaiting 自动展开", () => {
    let st = S({ review: "running" });
    st = S({ review: "awaiting" }, st);
    expect(isExpanded(st, "review")).toBe(true);
  });
  it("手动展开 done section 不被自动逻辑收起", () => {
    let st = S({ design: "done", dev: "pending" });
    st = toggleManual(st, "design"); // 展开
    st = S({ design: "done", dev: "running" }, st);
    expect(isExpanded(st, "design")).toBe(true);
    expect(isExpanded(st, "dev")).toBe(true); // 多展开共存
  });
});

describe("shouldFollow（追尾阈值 24px）", () => {
  it("贴底跟随，超 24px 暂停", () => {
    expect(shouldFollow(976, 1000, 0)).toBe(true);   // 距底 24
    expect(shouldFollow(975, 1000, 0)).toBe(false);  // 距底 25
    expect(shouldFollow(176, 1000, 800)).toBe(true); // clientHeight 参与
  });
});

describe("resolveLogPhase（log:entry 的 tag 可能是 label）", () => {
  const names = new Set(["design", "develop"]);
  const labelToName = { "设计": "design", "开发": "develop" };
  it("tag 即 phase name 直接命中", () => {
    expect(resolveLogPhase("design", labelToName, names)).toBe("design");
  });
  it("tag 是 label 时映射回 name", () => {
    expect(resolveLogPhase("设计", labelToName, names)).toBe("design");
  });
  it("无法解析 → null（不错挂）", () => {
    expect(resolveLogPhase("SYSTEM", labelToName, names)).toBe(null);
    expect(resolveLogPhase(undefined, labelToName, names)).toBe(null);
  });
});

describe("phaseRounds（驳回重跑轮数）", () => {
  it("同 phase 多条 events = 轮数", () => {
    const events = [{ phase: "design" }, { phase: "review" }, { phase: "design" }];
    expect(phaseRounds(events, "design")).toBe(2);
    expect(phaseRounds(events, "review")).toBe(1);
    expect(phaseRounds(events, "develop")).toBe(0);
  });
});

describe("fmtDuration", () => {
  it("秒 / 分秒 / 时分", () => {
    expect(fmtDuration(48_000)).toBe("48s");
    expect(fmtDuration(124_000)).toBe("2m04s");
    expect(fmtDuration(3_780_000)).toBe("1h03m");
  });
});

describe("extractLevel（从 PhaseLogsViewer 平移）", () => {
  it("解析方括号 level", () => {
    expect(extractLevel("2026-06-10 10:00:00 [INFO] [设计] hi")).toBe("INFO");
    expect(extractLevel("plain line")).toBe(null);
    expect(LEVEL_RE.test(" [ERROR] ")).toBe(true);
  });
});

// ── 线性执行时间线 ────────────────────────────────────────────

import { buildTimeline, parseLineTs, filterLinesToWindow, assignAgentCalls } from "../src/web/src/lib/run-view-logic";

it("buildTimeline: 驳回重做按发生顺序铺开，每轮独立 + 未执行 phase 进 pending", () => {
  const T = 1781000000000;
  const events = [
    { id: 1, phase: "design", status: "done" as const, started_at: T, ended_at: T + 60_000 },
    { id: 2, phase: "review", status: "done" as const, started_at: T + 61_000, ended_at: T + 90_000 },
    { id: 3, phase: "design", status: "done" as const, started_at: T + 91_000, ended_at: T + 150_000 },
    { id: 4, phase: "review", status: "running" as const, started_at: T + 151_000, ended_at: null },
  ];
  const { runs, pending } = buildTimeline(events, ["design", "review", "develop", "submit_pr"]);
  expect(runs.map((r) => `${r.phase}#${r.attempt}`)).toEqual(["design#1", "review#1", "design#2", "review#2"]);
  expect(runs[0].totalAttempts).toBe(2);
  expect(runs[3].state).toBe("running");
  expect(runs[3].endedMs).toBe(null);
  expect(pending).toEqual(["develop", "submit_pr"]);
});

it("buildTimeline: 秒级时间戳归一为毫秒", () => {
  const { runs } = buildTimeline(
    [{ id: 1, phase: "a", status: "done" as const, started_at: 1781000000, ended_at: 1781000060 }],
    ["a"],
  );
  expect(runs[0].startedMs).toBe(1781000000000);
  expect(runs[0].endedMs).toBe(1781000060000);
});

it("parseLineTs: 解析行首时间戳，无时间戳返回 null", () => {
  // logger 落盘 UTC 字符串 → 必须按 UTC 解析（带 Z），否则与 epoch 窗口错开时区差
  expect(parseLineTs("2026-06-10 05:50:44 [INFO] hello")).toBe(new Date("2026-06-10T05:50:44Z").getTime());
  expect(parseLineTs("    continuation line")).toBe(null);
});

it("filterLinesToWindow: 按时间窗切片，延续行跟随归属", () => {
  const at = (s: string) => new Date(`2026-06-10T${s}Z`).getTime();
  const lines = [
    "2026-06-10 10:00:00 [INFO] round1 start",
    "  round1 detail",
    "2026-06-10 10:05:00 [INFO] round1 end",
    "2026-06-10 10:10:00 [INFO] round2 start",
    "  round2 detail",
  ];
  const round1 = filterLinesToWindow(lines, at("10:00:00"), at("10:05:30"));
  expect(round1).toEqual(lines.slice(0, 3));
  const round2 = filterLinesToWindow(lines, at("10:09:00"), null);
  expect(round2).toEqual(lines.slice(3));
});

it("isNeverRun: 只有 idle/pending 算从未执行；aborted 是被打断的已执行轮（有日志必须展示）", () => {
  expect(isNeverRun("idle")).toBe(true);
  expect(isNeverRun("pending")).toBe(true);
  // dogfood-bug：daemon 重启打断的第 1 轮曾被映射成 idle → 「尚未开始」且不拉日志
  expect(isNeverRun("aborted")).toBe(false);
  expect(isNeverRun("running")).toBe(false);
  expect(isNeverRun("done")).toBe(false);
  expect(isNeverRun("failed")).toBe(false);
  expect(isNeverRun("awaiting")).toBe(false);
});

it("assignAgentCalls: 按 phase + 时间窗分发；窗口对不上时落到该 phase 最后一轮", () => {
  const T = 1781000000000;
  const runs = buildTimeline(
    [
      { id: 1, phase: "design", status: "done" as const, started_at: T, ended_at: T + 100_000 },
      { id: 2, phase: "design", status: "done" as const, started_at: T + 200_000, ended_at: T + 300_000 },
    ],
    ["design"],
  ).runs;
  const calls = [
    { seq: 1, ts: new Date(T + 90_000).toISOString(), phase: "design", elapsed_ms: 80_000 },  // 第 1 轮内
    { seq: 2, ts: new Date(T + 290_000).toISOString(), phase: "design", elapsed_ms: 80_000 }, // 第 2 轮内
    { seq: 3, ts: new Date(T + 999_000).toISOString(), phase: "design", elapsed_ms: 1000 },   // 窗外 → 最后一轮
  ];
  const byRun = assignAgentCalls(calls, runs);
  expect(byRun[runs[0].key]?.map((c) => c.seq)).toEqual([1]);
  expect(byRun[runs[1].key]?.map((c) => c.seq)).toEqual([2, 3]);
});
