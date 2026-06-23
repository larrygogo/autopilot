import type { RunnerBackend } from "./backend";
import { acquireRunnerLock, releaseRunnerLock } from "./lock";
import { log } from "../../core/logger";

export interface PollerOpts {
  /** /sessions/pending 长轮询挂起秒数（§4.2，50s）。测试 0。 */
  pollWaitSeconds: number;
  /** runner 级心跳间隔（§4.2，30s）。 */
  heartbeatMs: number;
  /** 领到 session 后跑回合循环（生产 = 绑 session-loop；测试桩）。 */
  runSession: (sessionId: string) => Promise<void>;
  /** claim 出错退避基准（jitter，默认 2s）。 */
  backoffBaseMs?: number;
  /**
   * 空领（claimPending 立即返 204/null）后的短退避（默认 250ms）。
   * 正常 50s 长轮询时服务端挂起、claim 不会立即返回，此值无感；但服务端若不挂起立即返
   * 204（misbehaving/旧后端，或测试用 pollWaitSeconds=0），不退避会变 100% CPU 紧自旋、
   * 且 await-已决议-promise 的微任务环会饿死宏任务定时器（dispose/心跳跑不动）。让出宏任务队列。
   */
  idleBackoffMs?: number;
}

/**
 * runner poller（§6.1）：抢 runner.lock 单实例 → runner 心跳 + 长轮询 /sessions/pending →
 * 领到 session 则跑回合循环、**期间停止 /pending 长轮询（忙则停领，避免 claim 第二个跑不动卡 queued；
 * 多 session 并发留 R3）** → 终态后恢复领活。
 */
export class RunnerPoller {
  private busy = false;
  private stopped = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  constructor(private readonly backend: RunnerBackend, private readonly opts: PollerOpts) {}

  start(): void {
    if (!acquireRunnerLock()) {
      throw new Error("runner.lock 已被占用：另一实例正在运行（同一 AUTOPILOT_HOME 只能一个 runner）。");
    }
    log.info("runner poller 启动（pollWait=%ss, heartbeat=%dms）", this.opts.pollWaitSeconds, this.opts.heartbeatMs);
    this.heartbeatTimer = setInterval(() => {
      this.backend.runnerHeartbeat().catch((e: unknown) => log.warn("runner 心跳失败：%s", e instanceof Error ? e.message : String(e)));
    }, this.opts.heartbeatMs);
    void this.loop();
  }

  private async loop(): Promise<void> {
    const base = this.opts.backoffBaseMs ?? 2000;
    while (!this.stopped) {
      if (this.busy) { await this.sleep(50); continue; } // 忙则停领
      try {
        const pending = await this.backend.claimPending(this.opts.pollWaitSeconds);
        // 204 超时无活：短退避后再长轮询（让出宏任务队列，防紧自旋饿死定时器，见 idleBackoffMs）。
        if (!pending) { await this.sleep(this.opts.idleBackoffMs ?? 250); continue; }
        this.busy = true;
        log.info("runner 领到 session %s（stage=%s），开始执行", pending.session_id, pending.current_stage);
        try {
          await this.opts.runSession(pending.session_id);
        } catch (e: unknown) {
          log.error("runner session %s 执行异常：%s", pending.session_id, e instanceof Error ? e.message : String(e));
        } finally {
          this.busy = false;
        }
      } catch (e: unknown) {
        log.warn("claimPending 异常，退避重试：%s", e instanceof Error ? e.message : String(e));
        await this.sleep(base + Math.floor(Math.random() * base)); // jitter 退避
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  dispose(): void {
    this.stopped = true;
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    this.backend.deregister().catch(() => { /* 下线 best-effort */ });
    releaseRunnerLock();
    log.info("runner poller 已停止");
  }
}
