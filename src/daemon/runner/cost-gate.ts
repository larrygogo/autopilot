/**
 * 成本闸门（§4.3，安全闸非优化）：单 round 墙钟超时 + per-stage 轮数上限（含 rework）+
 * 全 session 轮数上限。触顶由 session-loop 产 limit_hit/session_failed 事件让大脑可见，
 * 不静默退出。
 */

/** 给 promise 套墙钟超时；超时 reject 带 label（"round" / "stage" 等）。 */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export interface CostLimits {
  /** 全 session 总轮上限（如 30）。 */
  sessionMax: number;
  /** per-stage 轮上限（含 rework，防死循环，如 5）。 */
  stageMax: number;
}

/** 双闸计数器：session 累计 + per-stage 累计。 */
export class CostBudget {
  private sessionRounds = 0;
  private stageRounds = new Map<string, number>();
  constructor(private readonly limits: CostLimits) {}

  tickSession(): void {
    this.sessionRounds++;
  }
  tickStage(stage: string): void {
    this.stageRounds.set(stage, (this.stageRounds.get(stage) ?? 0) + 1);
  }

  sessionExceeded(): boolean {
    return this.sessionRounds >= this.limits.sessionMax;
  }
  stageExceeded(stage: string): boolean {
    return (this.stageRounds.get(stage) ?? 0) >= this.limits.stageMax;
  }
}
