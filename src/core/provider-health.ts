/**
 * Provider 健康度（内存态）
 *
 * 设计动机：provider（Anthropic / OpenAI / Google）的凭证由各自 CLI 自身管理，
 * daemon 没有有效的主动健康检查端点。所以我们采取"反应式"策略：
 * 把每次 Agent.run / Agent.chat 的成功/失败记录下来，当某 provider 连续失败 ≥
 * UNHEALTHY_THRESHOLD 次时标记为不健康，并 emit `provider:health-changed`。
 * 任何一次成功立即重置为健康。
 *
 * 内存态，daemon 重启即清。重启后若问题仍在，下一次失败会再次推出卡片。
 */

import { emit } from "./event-bus";

export interface ProviderHealthState {
  provider: string;
  healthy: boolean;
  /** 连续失败次数；任何一次成功重置为 0 */
  consecutive_failures: number;
  /** 最近一次失败的原因（短文本） */
  last_reason?: string;
  /** 首次失败时间（epoch ms） */
  first_failed_at?: number;
  /** 最近一次调用时间（epoch ms） */
  last_seen_at: number;
}

const UNHEALTHY_THRESHOLD = 2;

const _states = new Map<string, ProviderHealthState>();

function summarize(reason: string): string {
  // 限长，避免巨长 stack trace 进事件
  const flat = reason.replace(/\s+/g, " ").trim();
  return flat.length > 200 ? flat.slice(0, 200) + "…" : flat;
}

export function recordProviderSuccess(provider: string): void {
  const prev = _states.get(provider);
  const now = Date.now();
  _states.set(provider, {
    provider,
    healthy: true,
    consecutive_failures: 0,
    last_reason: undefined,
    first_failed_at: undefined,
    last_seen_at: now,
  });
  if (prev && !prev.healthy) {
    emit({
      type: "provider:health-changed",
      payload: { provider, healthy: true, ts: now },
    });
  }
}

export function recordProviderFailure(provider: string, reason: string): void {
  const prev = _states.get(provider);
  const now = Date.now();
  const consecutive = (prev?.consecutive_failures ?? 0) + 1;
  const trimmed = summarize(reason);
  const next: ProviderHealthState = {
    provider,
    healthy: consecutive < UNHEALTHY_THRESHOLD,
    consecutive_failures: consecutive,
    last_reason: trimmed,
    first_failed_at: prev?.first_failed_at ?? now,
    last_seen_at: now,
  };
  _states.set(provider, next);
  // 健康 → 不健康：第一次跨阈值
  if ((prev?.healthy ?? true) && !next.healthy) {
    emit({
      type: "provider:health-changed",
      payload: { provider, healthy: false, reason: trimmed, ts: now },
    });
  }
}

export function getProviderHealth(provider: string): ProviderHealthState | undefined {
  return _states.get(provider);
}

export function listUnhealthy(): ProviderHealthState[] {
  return Array.from(_states.values()).filter((s) => !s.healthy);
}

/** 测试专用：清空全部状态 */
export function _resetForTest(): void {
  _states.clear();
}
