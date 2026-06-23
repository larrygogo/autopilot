// 对齐证明（spec §6.1/§11「session-loop 移植与 agent-worker 行为对齐」）：
// autopilot src/daemon/runner/session-loop.ts 是 agent-worker/sessionLoop.mjs 的 TS 移植。
// 本测试把参考实现 test（agent-worker/test/sessionLoop.test.mjs）的 8 个事件剧本逐一翻译过来，
// 喂给 autopilot 移植版，断言**可观察行为**与参考逐字一致（防移植漂移）。
//
// ────────────────────────────────────────────────────────────────────────────
// ⚠️ API 形状偏离（计划 Task 3 Step 1 要求记录的差异——C 暴露 A2 偏离 spec 假设的设计点）：
//
//   计划假设的签名（沿用参考 .mjs）：
//     runSessionLoop({ backend, queue: SignalQueue, ctx: { roundFn, maxRounds, pollMs } })
//       → { reason: 'approved'|'terminal'|'max_rounds', rounds }
//
//   A2 实际落地的签名（src/daemon/runner/session-loop.ts）：
//     runSessionLoop(sessionId: string, backend: RunnerBackend, deps: SessionLoopDeps) → void
//
//   差异逐项（均为**实现形状变化，行为不变式保留**）：
//   1. 无 SignalQueue：A2 改纯轮询（sleep(pollMs)）唤醒——「信号只是叫醒、事件流是唯一事实源」
//      的不变式仍成立（参考的 SignalQueue 本就只作叫醒、内容靠 fetchEvents），故参考的
//      「丢信号轮询兜底」剧本在 A2 是**默认行为**（A2 根本没有信号，永远靠轮询）。
//      → 参考剧本⑧（SignalQueue push/next 单元测试）在 A2 无对应物，记为 N/A（见文末说明）。
//   2. 返回 void 而非 {reason, rounds}：A2 把终态语义编码进**事件流 + 退出**而非返回值：
//        - reason='approved' / 'terminal'  → 循环干净退出（不再跑 round），无 limit_hit/session_failed；
//        - reason='max_rounds'（参考的失控兜底）→ A2 用 CostBudget 双闸（sessionMax/stageMax），
//          触顶**产 limit_hit + session_failed 事件**后退出（比参考更显式，大脑可见）。
//      故本测试把 reason 断言翻译成：① 统计 runStageRound 调用次数（= rounds）；
//      ② 检查 posted 事件里有/无 limit_hit+session_failed（= approved/terminal vs max_rounds）。
//   3. roundFn(ctx) → runStageRound(session, accumulated)：上下文（accumulated）从第 2 参数取，
//      断言「第 N 回合 accumulated 含某文本」改为捕获 runStageRound 的 accumulated 入参。
//   4. accumulated 拼接格式不同：参考 `\n用户消息(by): msg`，A2 `\n${msg}`（types.wireToSessionEvent
//      已把 payload.message→ev.text，session-loop 读 ev.text 直拼）。两者都保证「答案/评论并入下一回合
//      上下文 + 多人插话按 seq 序」——本测试断言「accumulated 包含答案文本 + 先于后」，不绑死格式。
//   5. gate 等待：参考内联 waitFor 轮询事件流；A2 抽成可注入 deps.waitGate(gateId, sessionId)。
//      「gate_id 后端注入、伪造/错配 gate_id 不生效」的不变式由 backend.postEvent 回填真 gate_id +
//      waitGate 按该 gate_id 匹配保证——本测试用真实事件流驱动 defaultWaitGate（不走桩），逐字复刻。
// ────────────────────────────────────────────────────────────────────────────

import { test, expect } from "bun:test";
import { runSessionLoop, defaultWaitGate } from "../src/daemon/runner/session-loop";
import type { RunnerBackend } from "../src/daemon/runner/backend";
import type { SessionEvent, SessionState, SessionStage, SessionStatus, PendingSession } from "../src/daemon/runner/types";

// ── 参考 fakeBackend 的 A2 翻译 ──────────────────────────────────────────────
// 复刻 agent-worker/test/sessionLoop.test.mjs 的内存假后端：seq 分配 / gate_id 注入 / 状态机。
// 但实现 A2 的 RunnerBackend 接口（fetchEvents/postEvent/getSession/sessionHeartbeat/...）。
// 关键：events 表是唯一事实源，emit() 模拟「用户在网页操作产生的事件」，与参考一一对应。
interface FakeBackend extends RunnerBackend {
  events: SessionEvent[];
  state: { status: SessionStatus; current_stage: SessionStage };
  /** 测试侧注入事件（= 参考的 emit）。线协议 payload 形状，经 fetchEvents 归一为扁平 SessionEvent。 */
  emit(eventType: string, payload?: Record<string, unknown>): void;
}

function fakeBackend(initialStage: SessionStage = "spec"): FakeBackend {
  const events: SessionEvent[] = [];
  let seq = 0;
  let gateN = 0;
  const state = { status: "running" as SessionStatus, current_stage: initialStage };

  /** 把线协议 payload 提平到 A2 扁平 SessionEvent（与 types.wireToSessionEvent 同语义，测试内联）。 */
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
      // 移植保真：runner 永不自定 seq（占位 0），后端定序 + gate_opened 注入 gate_id（参考同款）。
      expect(ev.seq).toBe(0);
      const stored: SessionEvent = { ...ev, seq: ++seq };
      if (ev.type === "gate_opened") stored.gate_id = `gate-${++gateN}`;
      events.push(stored);
      return stored;
    },
    async getSession() {
      return { id: "sess-1", status: state.status, current_stage: state.current_stage, repos: [] };
    },
    async getGitToken() { return "tok"; },
    async sessionHeartbeat() { return { terminal: false }; },
    async runnerHeartbeat() {},
    async claimPending(): Promise<PendingSession | null> { return null; },
    async deregister() {},
  };
}

// ── 参考剧本的 round 产出（逐字复刻 clarifyRound / gateRound）──────────────────
// 参考产线协议 {event_type, payload}；A2 runStageRound 产扁平 SessionEvent（seq=0 占位）。
const clarifyRound = (): SessionEvent[] => [
  { seq: 0, type: "assistant_message", text: "v1" },
  { seq: 0, type: "clarification_requested", text: "默认值?" },
];
const gateRound = (v: string): SessionEvent[] => [
  { seq: 0, type: "stage_artifact", text: v, artifact: { kind: "spec", content: v } },
  { seq: 0, type: "gate_opened" },
];

/** 等多个 setTimeout 注入完成的最大延迟 + 余量（参考用真定时器，A2 同样真跑）。 */
const LIMITS = { sessionMax: 30, stageMax: 5 };

// ════════════════════════════════════════════════════════════════════════════
// 对齐①：闭环——澄清→事件流拉到回答→重跑→gate approve 结束。
// 参考断言：reason=approved, rounds=2, 第 2 回合 accumulated 含澄清答案。
// A2 翻译：runStageRound 调 2 次；第 2 次入参 accumulated 含「默认 medium」；
//          无 limit_hit/session_failed（= approved 而非 max_rounds）；干净退出。
// ════════════════════════════════════════════════════════════════════════════
test("对齐①：澄清→拉到回答→重跑→gate approve 结束（rounds=2，第2回合含答案，approved 退出）", async () => {
  const b = fakeBackend("spec");
  const contexts: string[] = [];
  const outputs = [clarifyRound(), gateRound("v2")];
  let rounds = 0;

  const loop = runSessionLoop("sess-1", b, {
    runStageRound: async (_session, accumulated) => {
      contexts.push(accumulated);
      rounds++;
      return outputs.shift()!;
    },
    pollMs: 5,
    limits: LIMITS,
    roundTimeoutMs: 5000,
    waitGate: (gateId, sid) => defaultWaitGate(b, gateId, sid, 5),
  });

  // 用户回答澄清：事件先落库（信号只是叫醒，A2 无信号、纯轮询拉取）
  setTimeout(() => b.emit("user_message", { message: "默认 medium", by_name: "甲" }), 10);
  // 批准 gate（gate-1 由假后端在 postEvent 注入）+ 大脑推进 stage → done
  setTimeout(() => {
    b.emit("gate_decided", { gate_id: "gate-1", decision: "approved" });
    b.state.current_stage = "done";
    b.state.status = "completed";
  }, 40);

  await loop;
  expect(rounds).toBe(2);
  expect(contexts[1]).toContain("默认 medium"); // 第 2 回合上下文含澄清答案
  expect(b.events.some((e) => e.type === "limit_hit")).toBe(false); // approved，非 max_rounds 兜底
});

// ════════════════════════════════════════════════════════════════════════════
// 对齐②：丢信号轮询兜底推进（参考 reason=approved）。
// A2 翻译：A2 本就纯轮询（无 SignalQueue），此剧本是 A2 默认路径——只落事件不发任何信号，
//          gate 批准仍经 fetchEvents 拉到、循环干净退出（无 limit_hit）。
// ════════════════════════════════════════════════════════════════════════════
test("对齐②：丢信号（A2 纯轮询）→ gate 批准经事件流兜底推进退出", async () => {
  const b = fakeBackend("spec");
  let rounds = 0;
  const loop = runSessionLoop("sess-1", b, {
    runStageRound: async () => { rounds++; return gateRound("s"); },
    pollMs: 5,
    limits: LIMITS,
    roundTimeoutMs: 5000,
    waitGate: (gateId, sid) => defaultWaitGate(b, gateId, sid, 5),
  });
  // 无信号、仅事件落库 + 推进终态
  setTimeout(() => {
    b.emit("gate_decided", { gate_id: "gate-1", decision: "approved" });
    b.state.current_stage = "done";
    b.state.status = "completed";
  }, 20);
  await loop;
  expect(rounds).toBe(1);
  expect(b.events.some((e) => e.type === "limit_hit")).toBe(false);
});

// ════════════════════════════════════════════════════════════════════════════
// 对齐③：伪造/错配 gate_id 不生效——只认事件流中匹配 gate_id 的裁决。
// 参考断言：rounds=1, reason=approved（错配 gate-999 不结束等待，真 gate-1 才结束）。
// A2 翻译：waitGate=defaultWaitGate（真按 gate_id 匹配）；错配裁决先到不生效，真裁决后到才退出；
//          runStageRound 只调 1 次。
// ════════════════════════════════════════════════════════════════════════════
test("对齐③：伪造/错配 gate_id 不生效（rounds=1，真 gate 才退出）", async () => {
  const b = fakeBackend("spec");
  let rounds = 0;
  const loop = runSessionLoop("sess-1", b, {
    runStageRound: async () => { rounds++; return gateRound("s"); },
    pollMs: 5,
    limits: LIMITS,
    roundTimeoutMs: 5000,
    waitGate: (gateId, sid) => defaultWaitGate(b, gateId, sid, 5),
  });
  // 错配 gate_id 的裁决先到 → 不应结束等待
  setTimeout(() => b.emit("gate_decided", { gate_id: "gate-999", decision: "approved" }), 10);
  // 真裁决稍后到达 → 推进终态退出
  setTimeout(() => {
    b.emit("gate_decided", { gate_id: "gate-1", decision: "approved" });
    b.state.current_stage = "done";
    b.state.status = "completed";
  }, 40);
  await loop;
  expect(rounds).toBe(1); // 错配裁决没让循环重跑/退出
  expect(b.events.some((e) => e.type === "limit_hit")).toBe(false);
});

// ════════════════════════════════════════════════════════════════════════════
// 对齐④：驳回→带评论重做→再批准。
// 参考断言：rounds=2, reason=approved, 第 2 回合 accumulated 含驳回评论。
// A2 翻译：第 1 round gate_opened → waitGate 返回 rejected+reworkComment → accumulated 累计评论 →
//          第 2 round runStageRound 入参 accumulated 含评论 → 第 2 gate approve 退出；runStageRound 2 次。
// ════════════════════════════════════════════════════════════════════════════
test("对齐④：驳回带评论重做再批准（rounds=2，重做回合含评论）", async () => {
  const b = fakeBackend("spec");
  const contexts: string[] = [];
  let rounds = 0;
  const loop = runSessionLoop("sess-1", b, {
    runStageRound: async (_session, accumulated) => {
      contexts.push(accumulated);
      rounds++;
      return gateRound("s");
    },
    pollMs: 5,
    limits: LIMITS,
    roundTimeoutMs: 5000,
    waitGate: (gateId, sid) => defaultWaitGate(b, gateId, sid, 5),
  });
  // gate-1 驳回带评论（payload.comment → 归一为 ev.text → waitGate.reworkComment）
  setTimeout(() => b.emit("gate_decided", { gate_id: "gate-1", decision: "rejected", comment: "漏了错误处理" }), 10);
  // gate-2（重做后产出的第 2 个 gate）批准 → 推进终态
  setTimeout(() => {
    b.emit("gate_decided", { gate_id: "gate-2", decision: "approved" });
    b.state.current_stage = "done";
    b.state.status = "completed";
  }, 50);
  await loop;
  expect(rounds).toBe(2);
  expect(contexts[1]).toContain("漏了错误处理"); // 重做回合携带驳回评论
  expect(b.events.some((e) => e.type === "limit_hit")).toBe(false);
});

// ════════════════════════════════════════════════════════════════════════════
// 对齐⑤：会话被取消（session_cancelled 事件 / 终态）→ 等待点优雅退出。
// 参考断言：reason=terminal。
// A2 翻译：getSession().status 变 cancelled → 下一次 SYNC 检测终态、干净退出，不产 limit_hit。
// ════════════════════════════════════════════════════════════════════════════
test("对齐⑤：session_cancelled → 终态优雅退出（无 limit_hit）", async () => {
  const b = fakeBackend("spec");
  let rounds = 0;
  const loop = runSessionLoop("sess-1", b, {
    runStageRound: async () => { rounds++; return gateRound("s"); },
    pollMs: 5,
    limits: LIMITS,
    roundTimeoutMs: 5000,
    // 取消后 waitGate 应靠 getSession 终态返回（defaultWaitGate 内含终态检测）
    waitGate: (gateId, sid) => defaultWaitGate(b, gateId, sid, 5),
  });
  setTimeout(() => {
    b.emit("session_cancelled", { by_name: "甲" });
    b.state.status = "cancelled";
  }, 20);
  await loop;
  // 优雅退出：跑了 1 轮（产 gate_opened 后等 gate，期间被取消）；不产成本闸门事件
  expect(rounds).toBeGreaterThanOrEqual(1);
  expect(b.events.some((e) => e.type === "limit_hit")).toBe(false);
  expect(b.events.some((e) => e.type === "session_failed")).toBe(false); // 取消 ≠ 失败
});

// ════════════════════════════════════════════════════════════════════════════
// 对齐⑥：失控兜底——参考 maxRounds（每轮澄清后机械回答永不收敛）。
// 参考断言：reason=max_rounds, rounds=3（maxRounds=3）。
// A2 翻译：A2 无 maxRounds，改 CostBudget 双闸——stageMax=3 时 clarify stage 第 3 轮触顶。
//          但 A2 的 clarify 等待态**不消耗 stage 预算**（M2 设计），故要触顶必须每轮都有新
//          user_message 让循环跳出等待态、真跑 round（与参考「机械回答永不收敛」同形）。
//          断言：runStageRound 调用 = stageMax 次（3），且产 limit_hit + session_failed（= max_rounds 兜底）。
// ════════════════════════════════════════════════════════════════════════════
test("对齐⑥：失控兜底——clarify 反复回答触 stageMax（rounds=3，产 limit_hit+session_failed）", async () => {
  const b = fakeBackend("clarify");
  let rounds = 0;
  let n = 0;
  const loop = runSessionLoop("sess-1", b, {
    runStageRound: async () => {
      // 每轮产 clarification_requested 后立即注入新 user_message（模拟机械回答、永不收敛）
      setTimeout(() => b.emit("user_message", { message: `答${n++}`, by_name: "甲" }), 3);
      rounds++;
      return clarifyRound();
    },
    pollMs: 5,
    limits: { sessionMax: 30, stageMax: 3 }, // stageMax=3 ≙ 参考 maxRounds=3
    roundTimeoutMs: 5000,
    waitGate: (gateId, sid) => defaultWaitGate(b, gateId, sid, 5),
  });
  await loop;
  expect(rounds).toBe(3); // clarify stage 跑满 stageMax=3 后触顶
  expect(b.events.some((e) => e.type === "limit_hit")).toBe(true); // 成本闸门可见（= max_rounds 兜底）
  expect(b.events.some((e) => e.type === "session_failed")).toBe(true); // A2 比参考更显式：触顶 = session_failed
});

// ════════════════════════════════════════════════════════════════════════════
// 对齐⑦：多人插话按 seq 序并入（事件流定序）。
// 参考断言：reason=approved；第 2 回合 accumulated 中「先」的位置 < 「后」。
// A2 翻译：clarify round 产 clarification_requested → 等待态；两条 user_message 按 seq 先后注入 →
//          下一轮 runStageRound 的 accumulated 中「先」index < 「后」index；gate approve 退出。
// ════════════════════════════════════════════════════════════════════════════
test("对齐⑦：多人插话按 seq 序并入（先 index < 后 index）", async () => {
  const b = fakeBackend("clarify");
  const contexts: string[] = [];
  const outputs = [clarifyRound(), gateRound("v")];
  const loop = runSessionLoop("sess-1", b, {
    runStageRound: async (_session, accumulated) => {
      contexts.push(accumulated);
      return outputs.shift()!;
    },
    pollMs: 5,
    limits: LIMITS,
    roundTimeoutMs: 5000,
    waitGate: (gateId, sid) => defaultWaitGate(b, gateId, sid, 5),
  });
  // 两条 user_message 按 seq 先后落库（A2 fetchEvents 按 events 数组顺序 = seq 序拼 accumulated）
  setTimeout(() => {
    b.emit("user_message", { message: "先", by_name: "甲" });
    b.emit("user_message", { message: "后", by_name: "乙" });
    // 收到回复退出等待态后，第 2 round 是 gateRound；推进 stage 让其继续到 gate
    b.state.current_stage = "spec";
  }, 15);
  setTimeout(() => {
    b.emit("gate_decided", { gate_id: "gate-1", decision: "approved" });
    b.state.current_stage = "done";
    b.state.status = "completed";
  }, 60);
  await loop;
  const c = contexts[1]!;
  expect(c.indexOf("先")).toBeGreaterThanOrEqual(0);
  expect(c.indexOf("先")).toBeLessThan(c.indexOf("后")); // 插话按 seq 保序
});

// ════════════════════════════════════════════════════════════════════════════
// 对齐⑧（API 偏离记录）：参考的 SignalQueue push/next 单元测试在 A2 无对应物。
// A2 移植版**删除了 SignalQueue**，改纯轮询唤醒（sleep(pollMs) 后回 SYNC 对账）。
// 「信号只是叫醒、事件流是唯一事实源」的不变式 = A2 的默认且唯一行为（永远靠轮询拉取），
// 故对齐② 已直接覆盖「无信号也能推进」这一 SignalQueue 存在的根本目的。
// 此处显式记录：SignalQueue 行为在 A2 = 退化为「每 pollMs 必醒一次」，无独立测试对象。
test("对齐⑧：SignalQueue 在 A2 已退化为纯轮询（无 SignalQueue 导出，行为由对齐② 覆盖）", async () => {
  // 静态证明 A2 session-loop 不再导出 SignalQueue（移植删除该机制，改纯轮询）。
  const mod = await import("../src/daemon/runner/session-loop");
  expect("SignalQueue" in mod).toBe(false);
  // 对齐②（丢信号纯轮询仍推进）即 SignalQueue「丢信号不死锁」目的的 A2 等价证明。
});
