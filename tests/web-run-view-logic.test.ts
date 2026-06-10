/**
 * GA 式执行视图（TaskRunView）纯逻辑测试。
 * spec: docs/superpowers/specs/2026-06-10-project-pipeline-list-and-ga-task-view-design.md（B5 交互规格）
 */
import { describe, it, expect } from "bun:test";
import {
  createExpandState, applyStatusTransitions, toggleManual, isExpanded,
  shouldFollow, resolveLogPhase, phaseRounds, fmtDuration,
  LEVEL_RE, extractLevel,
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
