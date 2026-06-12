/**
 * fix_revision 修复执行的单轮进度内存态（仿 clarifier-progress 的最小版）。
 *
 * 用户痛点：注入反馈转入修复后「看不到进度」—— 需求停在 fix_revision，
 * 页面上没有任何「有 agent 在干活」的信号。此模块给前端实时反馈当前
 * 修复轮处于哪个阶段、跑了多久。
 *
 * 每个 reqId 至多一个活跃 round；终态（done/errored）emit 后立刻删除，
 * trace 不持久化，daemon 重启即清（重启恢复由 runner 的启动扫描负责）。
 */

import { emit } from "../core/event-bus";

export interface FixRoundState {
  req_id: string;
  /** epoch ms，本轮开始时间 */
  started_at: number;
  phase: "preparing" | "fixing" | "done" | "errored";
}

const _rounds = new Map<string, FixRoundState>();

export function startFixRound(reqId: string): void {
  const state: FixRoundState = { req_id: reqId, started_at: Date.now(), phase: "preparing" };
  _rounds.set(reqId, state);
  emit({ type: "requirement:fix-round-update", payload: state });
}

export function setFixPhase(reqId: string, phase: FixRoundState["phase"]): void {
  const prev = _rounds.get(reqId);
  if (!prev) return;
  const next: FixRoundState = { ...prev, phase };
  _rounds.set(reqId, next);
  emit({ type: "requirement:fix-round-update", payload: next });
}

export function endFixRound(reqId: string, finalPhase: "done" | "errored"): void {
  const prev = _rounds.get(reqId);
  if (!prev) return;
  emit({ type: "requirement:fix-round-update", payload: { ...prev, phase: finalPhase } });
  _rounds.delete(reqId);
}

export function getFixRound(reqId: string): FixRoundState | undefined {
  return _rounds.get(reqId);
}

/** 测试专用：清空全部状态 */
export function _resetFixProgressForTest(): void {
  _rounds.clear();
}
