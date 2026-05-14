/**
 * Clarifier 单轮进度的内存态。
 *
 * 每个 reqId 至多一个活跃 round（同 reqId 重复 startRound 覆盖）。
 * round 完结时（done / aborted / errored）emit 最后一次事件后立刻从 Map 删除 ——
 * trace 不持久化，daemon 重启即清。
 *
 * 用户痛点：dogfood 多次反馈"不知道 AI 在想什么"。此模块给前端实时反馈
 * 当前 round 处于哪个阶段、第几次 LLM 调用、本轮 prompt 是什么。
 */

import { emit } from "../core/event-bus";

export interface ClarifierRoundState {
  req_id: string;
  /** epoch ms，本轮开始时间 */
  started_at: number;
  phase: "preparing" | "calling-llm" | "parsing" | "writing" | "done" | "aborted" | "errored";
  /** 0 = 第一次尝试；1 = 重试（最多 2 次） */
  attempt: 0 | 1;
  /** 本轮 prompt，截断到 16384 字符 */
  prompt: string | null;
  /** attempt 0 失败时的 parse error，给 attempt 1 用户看；截断到 16384 字符 */
  last_parse_error: string | null;
}

const MAX_LEN = 16384;

function truncate(s: string | null | undefined): string | null {
  if (s == null) return null;
  if (s.length <= MAX_LEN) return s;
  return s.slice(0, MAX_LEN) + "…";
}

const _rounds = new Map<string, ClarifierRoundState>();

export function startRound(reqId: string, prompt: string): void {
  const state: ClarifierRoundState = {
    req_id: reqId,
    started_at: Date.now(),
    phase: "preparing",
    attempt: 0,
    prompt: truncate(prompt),
    last_parse_error: null,
  };
  _rounds.set(reqId, state);
  emit({ type: "requirement:clarifier-round-update", payload: state });
}

export function setPhase(
  reqId: string,
  phase: ClarifierRoundState["phase"],
  patch?: Partial<Pick<ClarifierRoundState, "attempt" | "prompt" | "last_parse_error">>,
): void {
  const prev = _rounds.get(reqId);
  if (!prev) return;
  const next: ClarifierRoundState = {
    ...prev,
    phase,
    ...(patch?.attempt !== undefined ? { attempt: patch.attempt } : {}),
    ...(patch?.prompt !== undefined ? { prompt: truncate(patch.prompt) } : {}),
    ...(patch?.last_parse_error !== undefined ? { last_parse_error: truncate(patch.last_parse_error) } : {}),
  };
  _rounds.set(reqId, next);
  emit({ type: "requirement:clarifier-round-update", payload: next });
}

export function endRound(reqId: string, finalPhase: "done" | "aborted" | "errored"): void {
  const prev = _rounds.get(reqId);
  if (!prev) return;
  const final: ClarifierRoundState = { ...prev, phase: finalPhase };
  // emit 终态后立刻删除：前端拿到终态事件 → setRound(null)
  emit({ type: "requirement:clarifier-round-update", payload: final });
  _rounds.delete(reqId);
}

export function getRound(reqId: string): ClarifierRoundState | undefined {
  return _rounds.get(reqId);
}

export function listAllActive(): ClarifierRoundState[] {
  return [..._rounds.values()];
}

export function _resetForTest(): void {
  _rounds.clear();
}
