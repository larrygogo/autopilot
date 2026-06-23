import type { RunnerBackend } from "./backend";
import type { SessionEvent, SessionState } from "./types";
import { TERMINAL_STATUSES } from "./types";
import { CostBudget, withTimeout, type CostLimits } from "./cost-gate";
import { deleteRequirementRuntimeDir } from "../../core/requirements/clone";
import { log } from "../../core/logger";

/** waitGate 返回：批准则推进，驳回携带返工评论 + 目标 stage（reqgenie rework_target_stage）。 */
export interface GateOutcome {
  approved: boolean;
  reworkComment?: string;
  /**
   * 诊断字段：大脑希望返工到的目标 stage（来自 gate_decided.rework_target_stage）。
   * 仅供调试/日志参考——stage 推进由 getSession().current_stage 驱动，runner 不自驱 stage 跳转。
   */
  reworkStage?: SessionState["current_stage"];
}

/** session 级心跳间隔（§4.3 = 30s；每 30s 一次，防 reqgenie 90s reaper 误杀长跑 session）。 */
export const SESSION_HEARTBEAT_MS = 30_000;

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
  /**
   * session 心跳间隔（可注入，测试用；生产默认 SESSION_HEARTBEAT_MS=30s）。
   */
  heartbeatIntervalMs?: number;
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
  // 等待用户澄清时为 true，此状态下跳过成本闸门与 round 执行，直到收到新 user_message 或 stage 推进。
  let waitingClarify = false;
  let prevStageForClarify: string | null = null;

  // ── session 级心跳（§4.3）：30s 一次，防 reqgenie 90s reaper 误杀长跑 session ──
  let heartbeatStopped = false;
  const heartbeatInterval = deps.heartbeatIntervalMs ?? SESSION_HEARTBEAT_MS;
  const heartbeatTimer = setInterval(async () => {
    if (heartbeatStopped) return;
    try {
      const result = await backend.sessionHeartbeat(sessionId);
      if (result.terminal) {
        // 409 终态：大脑已决，优雅退出——信号 aborted 下一次 while 检查退出
        log.info("runner session %s 心跳返回 409（终态），准备退出", sessionId);
        deps.signal?.throwIfAborted?.(); // 如有外部 signal 顺带检查
        heartbeatStopped = true;
        clearInterval(heartbeatTimer); // 防止重复触发
      }
    } catch (e: unknown) {
      log.warn("runner session %s 心跳失败：%s", sessionId, e instanceof Error ? e.message : String(e));
    }
  }, heartbeatInterval);

  try {
    while (!deps.signal?.aborted && !heartbeatStopped) {
      // ── SYNC ──
      const incoming = await backend.fetchEvents(sessionId, lastSeq);
      let gotNewUserMessage = false;
      for (const ev of incoming) {
        if (ev.seq > lastSeq) lastSeq = ev.seq;
        // backend.fetchEvents 已把 reqgenie `payload.message`→`ev.text`（user_message）；再兜一层直读 payload，
        // 防未归一的原始事件让用户回复静默丢失。
        if (ev.type === "user_message") {
          const payload = (ev as { payload?: Record<string, unknown> }).payload;
          const msg = ev.text ?? (typeof payload?.message === "string" ? payload.message : undefined);
          if (msg) { accumulated += `\n${msg}`; gotNewUserMessage = true; }
        }
      }
      const session = await backend.getSession(sessionId);
      if (TERMINAL_STATUSES.has(session.status)) {
        log.info("runner session %s 终态 %s，退出回合循环", sessionId, session.status);
        cleanupSessionCodebase(sessionId);
        return;
      }

      // ── clarify 等待态：等新 user_message 或 stage 推进（不消耗成本预算）──
      if (waitingClarify) {
        const stageAdvanced = prevStageForClarify !== null && session.current_stage !== prevStageForClarify;
        if (!gotNewUserMessage && !stageAdvanced) {
          // 还在等用户，不跑 round，不计成本
          await sleep(deps.pollMs);
          continue;
        }
        // 收到用户回复或大脑推进 stage，退出等待态继续正常流程
        waitingClarify = false;
        prevStageForClarify = null;
      }

      // ── 闸门：session 上限 ──
      if (budget.sessionExceeded()) {
        await backend.postEvent(sessionId, { seq: 0, type: "limit_hit", text: `session 轮数触顶（${deps.limits.sessionMax}）` });
        await backend.postEvent(sessionId, { seq: 0, type: "session_failed", text: "session 成本闸门触顶" });
        cleanupSessionCodebase(sessionId);
        return;
      }
      // ── 闸门：per-stage 上限 ──
      if (budget.stageExceeded(session.current_stage)) {
        await backend.postEvent(sessionId, { seq: 0, type: "limit_hit", text: `stage ${session.current_stage} 轮数触顶（${deps.limits.stageMax}）` });
        await backend.postEvent(sessionId, { seq: 0, type: "session_failed", text: `stage ${session.current_stage} 反复返工触顶` });
        cleanupSessionCodebase(sessionId);
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
        // 进入等待用户澄清态：不盲目重跑，等收到新 user_message 或 stage 推进（不消耗 STAGE_MAX 预算）
        waitingClarify = true;
        prevStageForClarify = session.current_stage;
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
  } finally {
    // 确保无论以何种方式退出（正常/异常/abort），心跳定时器都被清理
    heartbeatStopped = true;
    clearInterval(heartbeatTimer);
  }
}

/**
 * 生产用 waitGate：轮询 fetchEvents 找匹配 gateId 的 gate_decided。
 * （session-loop 主循环复用 lastSeq 推进会与此竞争，故独立从当前 seq 起轮询、命中即返。）
 *
 * 驳回评论读取（spec §14.4）：reqgenie 把评论放进 `gate_decided` 的 `payload.comment`。`backend.fetchEvents`
 * 已把 `payload.comment`→`ev.text`、`payload.{decision,rework_target_stage,gate_id}`→顶层（见 types.wireToSessionEvent），
 * 故主路径读扁平字段即可。下面再兜一层「直读 payload」防御：万一上游喂来未归一的原始事件（绕过 backend 的桩/旧路径），
 * 评论也不会静默丢失（项目反复警惕的「撞墙-失忆-重撞」）。
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
      const payload = (ev as { payload?: Record<string, unknown> }).payload;
      const gid = ev.gate_id ?? (typeof payload?.gate_id === "string" ? payload.gate_id : undefined);
      if (ev.type === "gate_decided" && gid === gateId) {
        const decision = ev.decision ?? payload?.decision;
        const comment = ev.text ?? (typeof payload?.comment === "string" ? payload.comment : undefined);
        const reworkStage = ev.rework_target_stage ?? (typeof payload?.rework_target_stage === "string" ? payload.rework_target_stage : undefined);
        return {
          approved: decision === "approved",
          reworkComment: comment,
          reworkStage: reworkStage as GateOutcome["reworkStage"],
        };
      }
    }
    const s = await backend.getSession(sessionId);
    if (TERMINAL_STATUSES.has(s.status)) return { approved: false };
    await sleep(pollMs);
  }
  return { approved: false };
}

/**
 * session 终态收尾（§6.7）：整树回收 runtime/requirements/<sessionId>/（sessionId 当合成需求 id）。
 *
 * 必须整树删、不能只删 codebase/：runner session 是**合成身份、无 DB 需求行**，终态后没有任何
 * Web 浏览或 retention reaper 会再碰它（retention 按 DB 需求终态扫，碰不到无 DB 行的 session）。
 * 而 A1 executor 的 runRoundAgent→bindTaskRunRoot 把 agent-calls.jsonl/run 根落在
 * runtime/requirements/<sessionId>/runs/<rs-sessionId>/——只删 codebase/（deleteRequirementCodebase）
 * 会把 runs/ 与父目录永久泄漏（逐 session 累积磁盘）。故复用 deleteRequirementRuntimeDir
 * （整树删 codebase/ + runs/ + 清单）。零痕迹原则在 push 时已抹除 origin 凭证，此处仅回收磁盘。
 *
 * 注：deleteRequirementRuntimeDir 是纯 fs 回收 helper（rmSync），不触状态机/调度器/桥接，
 * 不违 A 模式红线（runner 仍是无状态执行器）。
 */
export function cleanupSessionCodebase(sessionId: string): void {
  try { deleteRequirementRuntimeDir(sessionId); } catch { /* best-effort 回收 */ }
}
