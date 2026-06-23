import type { RunnerBackend } from "./backend";
import type { SessionEvent, SessionState } from "./types";
import { TERMINAL_STATUSES } from "./types";
import { CostBudget, withTimeout, type CostLimits } from "./cost-gate";
import { log } from "../../core/logger";

/** waitGate 返回：批准则推进，驳回携带返工评论 + 目标 stage（reqgenie rework_target_stage）。 */
export interface GateOutcome {
  approved: boolean;
  reworkComment?: string;
  reworkStage?: SessionState["current_stage"];
}

export interface SessionLoopDeps {
  /** 跑一轮 stage round（生产 = rounds.runStageRound 绑真实 deps；测试桩）。 */
  runStageRound: (session: SessionState, accumulated: string) => Promise<SessionEvent[]>;
  /** 轮询间隔（WAIT 阶段等 user_message/gate_decided，§4.3 = 30s；测试调小）。 */
  pollMs: number;
  limits: CostLimits;
  /** 单 round 墙钟超时（§4.3 ROUND_TIMEOUT）。 */
  roundTimeoutMs: number;
  /**
   * 等 gate 决定（轮询 fetchEvents 找匹配 gate_id 的 gate_decided）。
   * 生产实现在本文件 defaultWaitGate；测试桩可直接返回。
   */
  waitGate: (gateId: string, sessionId: string) => Promise<GateOutcome>;
  signal?: AbortSignal;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 回合循环（§4.3，TS 移植 agent-worker sessionLoop.mjs）。照搬不变式：
 *  - seq 后端定（runner 产事件 seq=0 占位，postEvent 回填）
 *  - gate_id 后端注入（loop 用回填的 gate_id 等 gate_decided 匹配，防伪）
 *  - 双闸成本闸门触顶 → 产 limit_hit/session_failed，不静默退出
 *  - 用户输入围栏化（accumulated 注入 round prompt，rounds 层加分隔标记）
 */
export async function runSessionLoop(sessionId: string, backend: RunnerBackend, deps: SessionLoopDeps): Promise<void> {
  const budget = new CostBudget(deps.limits);
  let lastSeq = 0;
  let accumulated = "";

  while (!deps.signal?.aborted) {
    // ── SYNC ──
    const incoming = await backend.fetchEvents(sessionId, lastSeq);
    for (const ev of incoming) {
      if (ev.seq > lastSeq) lastSeq = ev.seq;
      if (ev.type === "user_message" && ev.text) accumulated += `\n${ev.text}`;
    }
    const session = await backend.getSession(sessionId);
    if (TERMINAL_STATUSES.has(session.status)) {
      log.info("runner session %s 终态 %s，退出回合循环", sessionId, session.status);
      return;
    }

    // ── 闸门：session 上限 ──
    if (budget.sessionExceeded()) {
      await backend.postEvent(sessionId, { seq: 0, type: "limit_hit", text: `session 轮数触顶（${deps.limits.sessionMax}）` });
      await backend.postEvent(sessionId, { seq: 0, type: "session_failed", text: "session 成本闸门触顶" });
      return;
    }
    // ── 闸门：per-stage 上限 ──
    if (budget.stageExceeded(session.current_stage)) {
      await backend.postEvent(sessionId, { seq: 0, type: "limit_hit", text: `stage ${session.current_stage} 轮数触顶（${deps.limits.stageMax}）` });
      await backend.postEvent(sessionId, { seq: 0, type: "session_failed", text: `stage ${session.current_stage} 反复返工触顶` });
      return;
    }

    // ── ROUND ──
    budget.tickSession();
    budget.tickStage(session.current_stage);
    let produced: SessionEvent[];
    try {
      produced = await withTimeout(deps.runStageRound(session, accumulated), deps.roundTimeoutMs, "round");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      await backend.postEvent(sessionId, { seq: 0, type: "limit_hit", text: `round 失败/超时：${msg}` });
      // 超时不立即 failed：回 SYNC 让闸门累计，反复超时由 STAGE_MAX 收口
      await sleep(deps.pollMs);
      continue;
    }

    // 回写事件，后端定 seq + 注入 gate_id（回填值留作 WAIT 用）
    const filled: SessionEvent[] = [];
    for (const ev of produced) filled.push(await backend.postEvent(sessionId, ev));
    if (filled.length === 0) { await sleep(deps.pollMs); continue; }
    const last = filled[filled.length - 1]!;

    // ── WAIT ──
    if (last.type === "clarification_requested") {
      // 等用户回复（reqgenie 飞书/web 注入 user_message）：下一轮 SYNC 自然带回
      await sleep(deps.pollMs);
      continue;
    }
    if (last.type === "gate_opened" && last.gate_id) {
      const outcome = await deps.waitGate(last.gate_id, sessionId);
      if (!outcome.approved) {
        // rework：累计驳回评论，回 SYNC 重做（rounds 层据 accumulated 非空走增量）
        if (outcome.reworkComment) accumulated += `\n${outcome.reworkComment}`;
        await sleep(deps.pollMs);
        continue;
      }
      // 批准：大脑推进 stage，下一轮 SYNC 的 getSession 拿到新 current_stage
      accumulated = ""; // 进下一 stage 清返工上下文
      await sleep(deps.pollMs);
      continue;
    }
    if (last.type === "pr_created") {
      // pr 已交付，等大脑写 pr_url → done（下一轮 SYNC 检测终态退出）
      await sleep(deps.pollMs);
      continue;
    }
    // 其他（纯 assistant_message 推进）：直接进下一轮
    await sleep(deps.pollMs);
  }
}

/**
 * 生产用 waitGate：轮询 fetchEvents 找匹配 gateId 的 gate_decided。
 * （session-loop 主循环复用 lastSeq 推进会与此竞争，故独立从当前 seq 起轮询、命中即返。）
 */
export async function defaultWaitGate(
  backend: RunnerBackend,
  gateId: string,
  sessionId: string,
  pollMs: number,
  signal?: AbortSignal,
): Promise<GateOutcome> {
  let after = 0;
  while (!signal?.aborted) {
    const evs = await backend.fetchEvents(sessionId, after);
    for (const ev of evs) {
      if (ev.seq > after) after = ev.seq;
      if (ev.type === "gate_decided" && ev.gate_id === gateId) {
        return {
          approved: ev.decision === "approved",
          reworkComment: ev.text,
          reworkStage: ev.rework_target_stage,
        };
      }
    }
    const s = await backend.getSession(sessionId);
    if (TERMINAL_STATUSES.has(s.status)) return { approved: false };
    await sleep(pollMs);
  }
  return { approved: false };
}
