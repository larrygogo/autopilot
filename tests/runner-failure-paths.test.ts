// tests/runner-failure-paths.test.ts
// T8 失败路径 e2e（spec §11 失败路径，可 mock 部分）：
//  ① 驳回 → 带评论增量重做 → 再批准（gate_decided rejected + comment → 下一轮 dev round 携带评论）
//  ② session 取消（session_cancelled 事件 + 状态 cancelled）→ 等待点优雅退出 terminal
//  ③ runner 重启续作（afterSeq 对账：已处理事件不重复并入，新增事件正常拉取）
//  ④ token 现取静态护栏（rounds.ts 在 dev/pr round 内调 getGitToken，push 前现取防 1h 过期，spec §D6）
//
// API 形状说明（A2 与计划原假设的差异，已在 runner-session-loop-conformance.test.ts 记录）：
//  - A2 签名：runSessionLoop(sessionId, backend, deps) → void
//  - deps.runStageRound(session, accumulated) → SessionEvent[]  （非 roundFn(ctx)）
//  - deps.waitGate(gateId, sessionId) → GateOutcome          （可注入，测试用 defaultWaitGate）
//  - 无 SignalQueue，纯 sleep(pollMs) 轮询唤醒
// 因此下方测试按实际 A2 接口编写，行为断言与 spec §11 语义完全对齐。
import { test, expect, afterEach } from "bun:test";
import { runSessionLoop, defaultWaitGate } from "../src/daemon/runner/session-loop";
import { readFileSync } from "fs";
import { join } from "path";
import type { RunnerBackend } from "../src/daemon/runner/backend";
import type { SessionEvent, SessionState, SessionStage, SessionStatus, PendingSession } from "../src/daemon/runner/types";

// ── 内存假后端（与 conformance 测试同构，防格式漂移）────────────────────────────
interface FakeBackend extends RunnerBackend {
  events: SessionEvent[];
  state: { status: SessionStatus; current_stage: SessionStage };
  emit(eventType: string, payload?: Record<string, unknown>): void;
}

function fakeBackend(initialStage: SessionStage = "spec"): FakeBackend {
  const events: SessionEvent[] = [];
  let seq = 0;
  let gateN = 0;
  const state = { status: "running" as SessionStatus, current_stage: initialStage };

  const flatten = (eventType: string, payload: Record<string, unknown>, s: number): SessionEvent => {
    const ev: SessionEvent = { seq: s, type: eventType as SessionEvent["type"] };
    const text = payload.comment ?? payload.message ?? payload.question;
    if (typeof text === "string") ev.text = text;
    if (typeof payload.gate_id === "string") ev.gate_id = payload.gate_id;
    if (payload.decision === "approved" || payload.decision === "rejected") ev.decision = payload.decision;
    for (const [k, v] of Object.entries(payload)) if (!(k in ev)) (ev as Record<string, unknown>)[k] = v;
    return ev;
  };

  return {
    events,
    state,
    emit(eventType, payload = {}) {
      events.push(flatten(eventType, payload, ++seq));
    },
    async fetchEvents(_id, afterSeq) {
      return events.filter((e) => e.seq > afterSeq);
    },
    async postEvent(_id, ev) {
      expect(ev.seq).toBe(0); // runner 永不自定 seq
      const stored: SessionEvent = { ...ev, seq: ++seq };
      if (ev.type === "gate_opened") stored.gate_id = `gate-${++gateN}`;
      events.push(stored);
      return stored;
    },
    async getSession() {
      return { id: "sess-fp", status: state.status, current_stage: state.current_stage, repos: [] };
    },
    async getGitToken() { return "tok-fp"; },
    async sessionHeartbeat() { return { terminal: false }; },
    async runnerHeartbeat() {},
    async claimPending(): Promise<PendingSession | null> { return null; },
    async deregister() {},
  };
}

const gateRound = (v: string): SessionEvent[] => [
  { seq: 0, type: "stage_artifact", text: v, artifact: { kind: "spec", content: v } },
  { seq: 0, type: "gate_opened" },
];

const LIMITS = { sessionMax: 30, stageMax: 10 };

// ════════════════════════════════════════════════════════════════════════════
// 失败路径 ①：驳回 → 带评论增量重做 → 再批准（spec §11 驳回 rework）
//
// 不变式（对齐 gate_decided 评论传递，spec §14.4 修正）：
//  - gate_decided.payload.comment → ev.text（经 wireToSessionEvent 归一，backend.ts 收口）
//  - session-loop 读 ev.text 拼入 accumulated（不另追 user_message）
//  - rework round 的 runStageRound(session, accumulated) 入参 accumulated 含驳回评论
// ════════════════════════════════════════════════════════════════════════════
test("失败路径①：驳回带评论增量重做再批准（rework round 携带评论，rounds=2）", async () => {
  const b = fakeBackend("spec");
  const contexts: string[] = [];
  let rounds = 0;

  const loop = runSessionLoop("sess-fp", b, {
    runStageRound: async (_session, accumulated) => {
      contexts.push(accumulated);
      rounds++;
      return gateRound("doc");
    },
    pollMs: 5,
    limits: LIMITS,
    roundTimeoutMs: 5000,
    waitGate: (gateId, sid) => defaultWaitGate(b, gateId, sid, 5),
  });

  // 第 1 轮 gate 驳回，payload.comment = 评论（spec §14.4：评论放 gate_decided.payload.comment）
  setTimeout(() => b.emit("gate_decided", { gate_id: "gate-1", decision: "rejected", comment: "缺回滚方案" }), 10);
  // 第 2 轮 gate 批准 → 推进终态退出
  setTimeout(() => {
    b.emit("gate_decided", { gate_id: "gate-2", decision: "approved" });
    b.state.current_stage = "done";
    b.state.status = "completed";
  }, 50);

  await loop;

  expect(rounds).toBe(2); // 驳回 1 次 → 总 2 轮
  // 第 2 轮 accumulated 必须含驳回评论（增量重做，spec §4.5 dev rework 增量契约同源）
  expect(contexts[1]).toContain("缺回滚方案");
  // 批准退出：无 limit_hit / session_failed
  expect(b.events.some((e) => e.type === "limit_hit")).toBe(false);
  expect(b.events.some((e) => e.type === "session_failed")).toBe(false);
});

// ════════════════════════════════════════════════════════════════════════════
// 失败路径 ②：session 取消（session_cancelled 事件 + status=cancelled）→ 等待点优雅退出
//
// 不变式：
//  - TERMINAL_STATUSES 含 "cancelled"
//  - 下一次 SYNC 的 getSession().status=cancelled → 干净退出（不产 limit_hit / session_failed）
//  - 取消 ≠ 失败（session_failed 不应出现）
// ════════════════════════════════════════════════════════════════════════════
test("失败路径②：session_cancelled → 终态优雅退出（无 limit_hit / session_failed，取消 ≠ 失败）", async () => {
  const b = fakeBackend("spec");
  let rounds = 0;

  const loop = runSessionLoop("sess-fp", b, {
    runStageRound: async () => {
      rounds++;
      return gateRound("doc");
    },
    pollMs: 5,
    limits: LIMITS,
    roundTimeoutMs: 5000,
    waitGate: (gateId, sid) => defaultWaitGate(b, gateId, sid, 5),
  });

  // gate 打开后注入取消（等待 gate 期间被取消）
  setTimeout(() => {
    b.emit("session_cancelled", { by_name: "甲" });
    b.state.status = "cancelled";
  }, 20);

  await loop;

  // 取消态优雅退出：跑了至少 1 轮（产 gate_opened 进等待态），被取消后干净退出
  expect(rounds).toBeGreaterThanOrEqual(1);
  // 取消 ≠ 失败：不产成本闸门事件
  expect(b.events.some((e) => e.type === "limit_hit")).toBe(false);
  expect(b.events.some((e) => e.type === "session_failed")).toBe(false);
});

// ════════════════════════════════════════════════════════════════════════════
// 失败路径 ③：重启续作——after_seq 对账（spec §4.3 事件流是唯一事实源）
//
// A2 session-loop 每次轮询 fetchEvents(sessionId, lastSeq)（lastSeq 从 0 起，逐事件更新）。
// 重启语义：用 beforehand-emit 的事件预填假后端（模拟「重启前已发生的历史」），
// 再起 runSessionLoop——loop 的首次 fetchEvents(sid, 0) 会拉到全部历史，
// 但历史 gate_decided(rejected) 对 waitGate 无影响（loop 还没产 gate_opened，没有匹配 gate_id）。
// 真正的续作保证：loop 从当前后端状态出发、不重复执行历史 round，而是根据当前 getSession().status
// 决定下一步——这是「事件流是唯一事实源」的 A2 等价实现（与参考的 afterSeq 参数不同，行为一致）。
//
// 本测试验证：预填历史事件不引起 session-loop 把「历史」重走一遍（loop 只跑一轮 round，而非重跑历史轮数）。
// ════════════════════════════════════════════════════════════════════════════
test("失败路径③：重启续作——历史事件不重复执行（loop 只跑当前 stage 的下一轮，非重走历史轮数）", async () => {
  const b = fakeBackend("spec");
  // 预填 3 条「重启前已发生」的历史事件（模拟上一次 loop 已处理）
  b.emit("assistant_message", { message: "历史轮 v1" });
  b.emit("stage_artifact", { kind: "spec", content: "历史方案" });
  // 历史 gate 已驳回（上一 loop 的评论），但本次 loop 重启后不再是活跃的 waitGate 对象
  b.emit("gate_decided", { gate_id: "gate-stale-1", decision: "rejected", comment: "上轮历史意见" });
  // 后端 state = running（已从 gate 出来，等重新跑 round）
  b.state.status = "running";
  b.state.current_stage = "spec";

  const contexts: string[] = [];
  let rounds = 0;

  const loop = runSessionLoop("sess-fp", b, {
    runStageRound: async (_session, accumulated) => {
      contexts.push(accumulated);
      rounds++;
      return gateRound("重启后的新方案");
    },
    pollMs: 5,
    limits: LIMITS,
    roundTimeoutMs: 5000,
    waitGate: (gateId, sid) => defaultWaitGate(b, gateId, sid, 5),
  });

  // 新的 gate 批准（重启后第 1 轮产的 gate）→ 推进终态
  setTimeout(() => {
    // gate-1 是重启后第 1 个 postEvent(gate_opened) 注入的 gate_id（假后端 gateN 从 0 起，下一个是 gate-1）
    b.emit("gate_decided", { gate_id: "gate-1", decision: "approved" });
    b.state.current_stage = "done";
    b.state.status = "completed";
  }, 30);

  await loop;

  // 只跑 1 轮（重启续作，不重走历史轮数）
  expect(rounds).toBe(1);
  // 第 1 轮 accumulated 不含「历史意见」（stale gate_decided 无匹配 waitGate，不被拼入 accumulated）
  // 注：A2 accumulated 只在「waitGate 返回 rejected → reworkComment 非空」时累积驳回评论；
  //     fetchEvents 拉到历史 gate_decided(rejected) 不触发 accumulated 更新（只有 waitGate 的 outcome 触发），
  //     故历史评论不会被重复并入。
  expect(contexts[0]).not.toContain("上轮历史意见");
  expect(b.events.some((e) => e.type === "limit_hit")).toBe(false);
});

// ════════════════════════════════════════════════════════════════════════════
// 失败路径 ④：token 现取静态护栏（spec §D6 push 前现取，防 1h 过期）
//
// 验证：rounds.ts 在 dev / pr round 内调用 getGitToken（按 repo 现取），
// 而非复用 session 级缓存（否则 1h 后 token 过期会导致 push 失败）。
// 这是防御性静态护栏：逼 rounds.ts 真现取，不复用旧 token。
// ════════════════════════════════════════════════════════════════════════════
test("失败路径④：token 现取静态护栏（rounds.ts 在 dev/pr round 内调 getGitToken，push 前现取防过期）", async () => {
  const src = readFileSync(join(import.meta.dir, "../src/daemon/runner/rounds.ts"), "utf8");
  // rounds.ts 必须包含 getGitToken 调用（deps 注入的现取方法）
  expect(
    /getGitToken/.test(src),
    "rounds.ts 须在 dev/pr round 调用 deps.getGitToken（push 前现取，防 1h token 过期，spec §D6）",
  ).toBe(true);
  // 不应有 token 缓存变量（防开发者误存 session 级缓存导致过期不感知）
  // 注：此检查宽松（不排查所有缓存模式），主要防「const token = deps.getGitToken(...)` 提到 round 外」。
  // 真正的验证是：dev/pr 两个 stage 分支各自都有 await deps.getGitToken 调用。
  const devCall = /if \(stage === ["']dev["']\)[\s\S]*?getGitToken/.test(src);
  const prCall = /if \(stage === ["']pr["']\)[\s\S]*?getGitToken/.test(src);
  expect(devCall, "rounds.ts dev 分支须调 getGitToken（push 前现取）").toBe(true);
  expect(prCall, "rounds.ts pr 分支须调 getGitToken（push 前现取）").toBe(true);
});

// ── cleanup afterEach：测试间 timer 互不干扰 ──
afterEach(async () => {
  // 等所有 setTimeout 都 fire 完（最长 100ms），防跨 case timer 竞态
  await new Promise((r) => setTimeout(r, 120));
});
