import { test, expect } from "bun:test";
import { runSessionLoop } from "../src/daemon/runner/session-loop";
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
