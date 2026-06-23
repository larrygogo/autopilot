import { test, expect } from "bun:test";
import { runSessionLoop, defaultWaitGate } from "../src/daemon/runner/session-loop";
import type { RunnerBackend } from "../src/daemon/runner/backend";
import type { SessionEvent, SessionState, PendingSession } from "../src/daemon/runner/types";

/** 可编程 mock backend：按脚本喂 getSession 状态序列 + 记录 postEvent。 */
function mockBackend(opts: {
  sessionScript: SessionState[];          // 每次 getSession 取下一个（末值粘滞）
  eventsByAfter?: Record<number, SessionEvent[]>;
}): RunnerBackend & { posted: SessionEvent[]; gateWaits: number } {
  let sIdx = 0;
  const posted: SessionEvent[] = [];
  let seqCounter = 100;
  return {
    posted, gateWaits: 0,
    async fetchEvents(_id, after) { return opts.eventsByAfter?.[after] ?? []; },
    async postEvent(_id, ev) {
      expect(ev.seq).toBe(0); // 移植保真：runner 永不自定 seq（占位 0）
      const filled = { ...ev, seq: ++seqCounter, gate_id: ev.type === "gate_opened" ? `g-${seqCounter}` : ev.gate_id };
      posted.push(filled);
      return filled;
    },
    async getSession() { const s = opts.sessionScript[Math.min(sIdx++, opts.sessionScript.length - 1)]!; return s; },
    async getGitToken() { return "tok"; },
    async sessionHeartbeat() { return { terminal: false }; },
    async runnerHeartbeat() {},
    async claimPending(): Promise<PendingSession | null> { return null; },
    async deregister() {},
  };
}

const S = (stage: SessionState["current_stage"], status: SessionState["status"]): SessionState => ({
  id: "sess-1", status, current_stage: stage, repos: [{ repo_id: "r1", alias: "app", remote_url: "https://x/app.git", default_branch: "main", primary: true }],
});

test("终态 session 立即退出，不跑 round", async () => {
  const be = mockBackend({ sessionScript: [S("done", "completed")] });
  let rounds = 0;
  await runSessionLoop("sess-1", be, { runStageRound: async () => { rounds++; return []; }, pollMs: 1, limits: { sessionMax: 30, stageMax: 5 }, roundTimeoutMs: 1000, waitGate: async () => ({ approved: true }) });
  expect(rounds).toBe(0);
});

test("spec round → gate_opened → 批准 → 进 done：事件经 backend 定序回填", async () => {
  const be = mockBackend({ sessionScript: [S("spec", "running"), S("done", "completed")] });
  await runSessionLoop("sess-1", be, {
    runStageRound: async () => [{ seq: 0, type: "assistant_message", text: "x" }, { seq: 0, type: "gate_opened" }],
    pollMs: 1, limits: { sessionMax: 30, stageMax: 5 }, roundTimeoutMs: 1000,
    waitGate: async (gateId) => { expect(gateId).toMatch(/^g-/); return { approved: true }; }, // gate_id 后端注入、loop 据此等
  });
  expect(be.posted.some((e) => e.type === "gate_opened" && e.gate_id?.startsWith("g-"))).toBe(true);
});

test("STAGE_MAX 触顶 → 产 limit_hit 不再跑该 stage", async () => {
  // session 永远停在 spec（gate 反复 rejected 回 spec）；stageMax=2 应在第 3 次前触顶
  const be = mockBackend({ sessionScript: [S("spec", "running")] });
  let rounds = 0;
  await runSessionLoop("sess-1", be, {
    runStageRound: async () => { rounds++; return [{ seq: 0, type: "gate_opened" }]; },
    pollMs: 1, limits: { sessionMax: 30, stageMax: 2 }, roundTimeoutMs: 1000,
    waitGate: async () => ({ approved: false, reworkComment: "再改", reworkStage: "spec" }),
  });
  expect(rounds).toBe(2);
  expect(be.posted.some((e) => e.type === "limit_hit")).toBe(true);
});

test("ROUND_TIMEOUT 触顶 → 产 limit_hit", async () => {
  const be = mockBackend({ sessionScript: [S("dev", "running")] });
  await runSessionLoop("sess-1", be, {
    runStageRound: () => new Promise((r) => setTimeout(() => r([]), 100)),
    pollMs: 1, limits: { sessionMax: 30, stageMax: 5 }, roundTimeoutMs: 10,
    waitGate: async () => ({ approved: true }),
  });
  expect(be.posted.some((e) => e.type === "limit_hit")).toBe(true);
});

// ── blocker：defaultWaitGate 读 gate_decided 评论（spec §14.4 = payload.comment，经 backend 归一到 ev.text）──

/** 极简 mock backend：fetchEvents 返回脚本事件，getSession 末值粘滞（不参与本测试的终态退出）。 */
function gateBackend(events: SessionEvent[], session: SessionState): RunnerBackend {
  return {
    async fetchEvents() { return events; },
    async postEvent(_id, ev) { return { ...ev, seq: 1 }; },
    async getSession() { return session; },
    async getGitToken() { return "tok"; },
    async sessionHeartbeat() { return { terminal: false }; },
    async runnerHeartbeat() {},
    async claimPending(): Promise<PendingSession | null> { return null; },
    async deregister() {},
  };
}

test("defaultWaitGate：rejected gate_decided 的评论命中（归一后 ev.text = payload.comment）", async () => {
  // 模拟 backend.fetchEvents 已归一：reqgenie payload.comment → 顶层 ev.text、decision/rework 同理。
  const be = gateBackend(
    [{ seq: 7, type: "gate_decided", gate_id: "g-42", decision: "rejected", text: "缺错误处理", rework_target_stage: "spec" }],
    S("spec", "running"),
  );
  const outcome = await defaultWaitGate(be, "g-42", "sess-1", 1);
  expect(outcome.approved).toBe(false);
  expect(outcome.reworkComment).toBe("缺错误处理"); // 评论不静默丢失（撞墙-失忆-重撞反模式）
  expect(outcome.reworkStage).toBe("spec");
});

test("defaultWaitGate：approved gate_decided → approved=true", async () => {
  const be = gateBackend(
    [{ seq: 7, type: "gate_decided", gate_id: "g-42", decision: "approved" }],
    S("spec", "running"),
  );
  const outcome = await defaultWaitGate(be, "g-42", "sess-1", 1);
  expect(outcome.approved).toBe(true);
});

test("defaultWaitGate：防御读未归一原始事件（payload.comment 直读，不丢评论）", async () => {
  // 万一上游喂来未经 backend 归一的原始 wire 事件（payload 嵌套），评论仍须命中。
  const raw = { seq: 7, type: "gate_decided", payload: { gate_id: "g-9", decision: "rejected", comment: "改方案", rework_target_stage: "spec" } } as unknown as SessionEvent;
  const be = gateBackend([raw], S("spec", "running"));
  const outcome = await defaultWaitGate(be, "g-9", "sess-1", 1);
  expect(outcome.approved).toBe(false);
  expect(outcome.reworkComment).toBe("改方案");
});
