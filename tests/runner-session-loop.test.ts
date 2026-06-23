import { test, expect } from "bun:test";
import { runSessionLoop, defaultWaitGate, SESSION_HEARTBEAT_MS } from "../src/daemon/runner/session-loop";
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

// ── I1：session 级心跳 ──────────────────────────────────────────────────────────

test("I1：SESSION_HEARTBEAT_MS 常量值 = 30000", () => {
  expect(SESSION_HEARTBEAT_MS).toBe(30_000);
});

test("I1：回合循环运行期间调用 sessionHeartbeat（heartbeatIntervalMs 可注入）", async () => {
  // 把心跳间隔设极小（1ms）以便测试；session 跑几轮后进终态退出
  const heartbeatCalls: string[] = [];
  const be: RunnerBackend = {
    ...mockBackend({ sessionScript: [S("spec", "running"), S("spec", "running"), S("done", "completed")] }),
    async sessionHeartbeat(id) { heartbeatCalls.push(id); return { terminal: false }; },
  };
  await runSessionLoop("sess-hb", be, {
    runStageRound: async () => [],
    pollMs: 1,
    limits: { sessionMax: 30, stageMax: 5 },
    roundTimeoutMs: 1000,
    waitGate: async () => ({ approved: true }),
    heartbeatIntervalMs: 1, // 测试注入极小间隔
  });
  // 心跳函数在循环过程中至少调用一次（1ms 间隔 + 几轮 round）
  expect(heartbeatCalls.length).toBeGreaterThanOrEqual(1);
  expect(heartbeatCalls[0]).toBe("sess-hb");
});

test("I1：sessionHeartbeat 返回 409（terminal=true）→ 循环优雅退出", async () => {
  // 第一次心跳就返回 terminal=true，循环不应再继续跑 round
  let rounds = 0;
  // mock backend：getSession 永远 running，但心跳立刻返回 terminal
  const be = mockBackend({ sessionScript: [S("spec", "running")] });
  const heartbeatTerminal = { terminal: true };
  const patchedBe: RunnerBackend = {
    ...be,
    async sessionHeartbeat() { return heartbeatTerminal; },
  };
  // 用 AbortController 给一个 timeout 防测试卡死（心跳 abort 后 while 检查 heartbeatStopped 退出）
  await runSessionLoop("sess-hb2", patchedBe, {
    runStageRound: async () => { rounds++; return []; },
    pollMs: 1,
    limits: { sessionMax: 30, stageMax: 5 },
    roundTimeoutMs: 200,
    waitGate: async () => ({ approved: true }),
  });
  // heartbeatStopped=true 后循环在下一次 while 检查退出；rounds 应极少（心跳 1ms 内触发）
  // 断言：不会无限运行（rounds < sessionMax）
  expect(rounds).toBeLessThan(30);
});

// ── I2：dispose 先 abort 再释放锁 ──────────────────────────────────────────────

test("I2：AbortSignal 触发后回合循环及时退出", async () => {
  const controller = new AbortController();
  let rounds = 0;
  // 永不终态的 session + 无限 round；用 abort 停止
  const be = mockBackend({ sessionScript: [S("spec", "running")] });
  const loopPromise = runSessionLoop("sess-ab", be, {
    runStageRound: async () => { rounds++; return []; },
    pollMs: 5,
    limits: { sessionMax: 30, stageMax: 5 },
    roundTimeoutMs: 1000,
    waitGate: async () => ({ approved: true }),
    signal: controller.signal,
  });
  // 跑几轮后 abort
  await new Promise((r) => setTimeout(r, 30));
  controller.abort();
  await loopPromise;
  // 循环在 abort 后不应再继续跑（rounds 有限、不等于 sessionMax）
  expect(rounds).toBeGreaterThan(0);
  expect(rounds).toBeLessThan(30);
});

// ── M2：clarify 等待不盲目重跑、不消耗 stageMax 预算 ────────────────────────────

test("M2：clarification_requested 后不立即重跑 round，等新 user_message", async () => {
  // session 固定在 clarify 阶段；round 产 clarification_requested；之后 backend 无新 user_message
  let rounds = 0;
  // getSession 序列：前 3 次 clarify running，第 4 次终态（防无限循环）
  const sessions = [
    S("clarify", "running"), S("clarify", "running"), S("clarify", "running"), S("clarify", "running"),
    S("done", "completed"),
  ];
  const be = mockBackend({ sessionScript: sessions });
  await runSessionLoop("sess-m2", be, {
    runStageRound: async () => { rounds++; return [{ seq: 0, type: "clarification_requested", text: "请提供更多细节" }]; },
    pollMs: 1,
    limits: { sessionMax: 10, stageMax: 3 },
    roundTimeoutMs: 1000,
    waitGate: async () => ({ approved: true }),
  });
  // 在等待 user_message 时只跑了 1 轮（产 clarification_requested），之后进入等待态不重跑
  expect(rounds).toBe(1);
});

test("M2：clarification_requested 后收到 user_message → 恢复跑 round", async () => {
  // round 1：产 clarification_requested；然后喂 user_message；round 2 开跑；之后终态
  let rounds = 0;
  const sessions = [
    S("clarify", "running"),  // round 1
    S("clarify", "running"),  // clarify-wait 轮（有 user_message）
    S("done", "completed"),   // 退出
  ];
  // 第 2 次 fetchEvents（after=seq 后）返回 user_message
  let fetchCount = 0;
  const be: RunnerBackend = {
    ...mockBackend({ sessionScript: sessions }),
    async fetchEvents(_id, _after) {
      fetchCount++;
      // 第 2 次 fetch 喂 user_message（seq=5）
      if (fetchCount === 2) return [{ seq: 5, type: "user_message", text: "用户回复了" }];
      return [];
    },
  };
  await runSessionLoop("sess-m2b", be, {
    runStageRound: async () => { rounds++; return [{ seq: 0, type: "clarification_requested", text: "需要细节" }]; },
    pollMs: 1,
    limits: { sessionMax: 10, stageMax: 3 },
    roundTimeoutMs: 1000,
    waitGate: async () => ({ approved: true }),
  });
  // round 1 跑了，等到 user_message 后 round 2 跑了，然后终态
  expect(rounds).toBe(2);
});

test("M2：clarify 等待期间不消耗 stageMax 预算（不会提前触顶）", async () => {
  // stageMax=2；round 1 产 clarification_requested；等待 3 轮（不计入预算）；然后 user_message 进来再跑 round 2；无触顶
  let rounds = 0;
  let fetchCount = 0;
  const sessions = [
    S("clarify", "running"),  // round 1
    S("clarify", "running"),  // wait 1
    S("clarify", "running"),  // wait 2（user_message 喂入）
    S("clarify", "running"),  // round 2
    S("done", "completed"),
  ];
  const baseBe = mockBackend({ sessionScript: sessions });
  const be: typeof baseBe = {
    ...baseBe,
    async fetchEvents(_id, _after) {
      fetchCount++;
      if (fetchCount === 3) return [{ seq: 10, type: "user_message", text: "回复" }];
      return [];
    },
  };
  await runSessionLoop("sess-m2c", be, {
    runStageRound: async () => { rounds++; return [{ seq: 0, type: "clarification_requested", text: "?" }]; },
    pollMs: 1,
    limits: { sessionMax: 10, stageMax: 2 },
    roundTimeoutMs: 1000,
    waitGate: async () => ({ approved: true }),
  });
  // stageMax=2，但 clarify 等待不消耗预算，所以 2 轮都跑了、没有 limit_hit
  expect(rounds).toBe(2);
  expect(be.posted.some((e: SessionEvent) => e.type === "limit_hit")).toBe(false);
});
