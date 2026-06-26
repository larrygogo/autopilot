/**
 * 分配轮询器（链路一）
 *
 * 长轮询 GET /assignments/pending → 命中后调本机 RPC 建需求 + setWorkspaces → ack。
 * best-effort：失败退避重试，不阻塞需求推进。
 */

import { createLogger } from "../../core/logger";
import type { SelfhostedBackend } from "./backend";
import type { ReqLink } from "./types";

const log = createLogger("selfhosted:assignments");

export interface AssignmentPollerDeps {
  /** HTTP 后端（可 mock） */
  backend: SelfhostedBackend;
  /** 长轮询挂起秒数（正常 50，测试 0） */
  pollWaitSeconds: number;
  /** 退避基准（jitter，默认 3000ms） */
  backoffBaseMs?: number;
  /** 空轮询后短退避（默认 250ms，防止后端不挂起时 CPU 紧自旋） */
  idleBackoffMs?: number;

  /**
   * 调本机 RPC 建需求（in-process 注入，测试可 mock）
   * 返回创建的 autopilot_req_id
   */
  createRequirement(params: {
    title: string;
    spec_md: string;
    source: string;
    external_ref: string;
    project_id?: string | null;
  }): Promise<string>;

  /**
   * 设置需求代码库（in-process 注入）
   * repo_urls → 已注册 workspace 的 remote_url 匹配或创建
   */
  setWorkspaces(params: {
    autopilot_req_id: string;
    repo_urls: string[];
  }): Promise<void>;

  /** 收到分配并建需求成功后回调（供 mirror-pusher 注册 link） */
  onLinkCreated(link: ReqLink): void;

  /**
   * 自动进澄清（in-process 注入）
   * 建需求 + setWorkspaces 后调此将需求转入 clarifying 态启动生命周期。
   * 无 repo_urls 时也可调（drafting → clarifying 是合法转换）。
   * 失败 best-effort log，不崩循环，不丢 ack。
   */
  transitionClarifying(autopilotReqId: string): Promise<void>;

  /** 触发全量快照（建需求后立即推初始状态） */
  triggerSnapshot(autopilotReqId: string): void;
}

export class AssignmentPoller {
  private stopped = false;

  constructor(private readonly deps: AssignmentPollerDeps) {}

  start(): void {
    log.info(
      "assignments-poller 启动（pollWait=%ss）",
      this.deps.pollWaitSeconds,
    );
    void this.loop();
  }

  private async loop(): Promise<void> {
    const base = this.deps.backoffBaseMs ?? 3000;
    while (!this.stopped) {
      try {
        const assignment = await this.deps.backend.claimAssignment(
          this.deps.pollWaitSeconds,
        );
        if (!assignment) {
          await this.sleep(this.deps.idleBackoffMs ?? 250);
          continue;
        }

        log.info(
          "收到分配 assignment_id=%s reqgenie_req_id=%s title=%s",
          assignment.assignment_id,
          assignment.reqgenie_req_id,
          assignment.title,
        );

        try {
          // 1. 建需求
          const autopilotReqId = await this.deps.createRequirement({
            title: assignment.title,
            spec_md: assignment.spec_md,
            source: "reqgenie",
            external_ref: assignment.reqgenie_req_id,
            project_id: assignment.project_hint ?? null,
          });

          // 2. 设置代码库（如有）
          if (assignment.repo_urls.length > 0) {
            try {
              await this.deps.setWorkspaces({
                autopilot_req_id: autopilotReqId,
                repo_urls: assignment.repo_urls,
              });
            } catch (e: unknown) {
              log.warn(
                "setWorkspaces 失败（继续）req=%s: %s",
                autopilotReqId,
                e instanceof Error ? e.message : String(e),
              );
            }
          }

          // 3. 注册 link（供 mirror-pusher 订阅）
          const link: ReqLink = {
            reqgenie_req_id: assignment.reqgenie_req_id,
            autopilot_req_id: autopilotReqId,
            assignment_id: assignment.assignment_id,
            mirror_seq: 0,
          };
          this.deps.onLinkCreated(link);

          // 4. Ack 分配（create 成功即回，workspace/transition/snapshot 失败不丢 ack）
          await this.deps.backend.ackAssignment(
            assignment.assignment_id,
            autopilotReqId,
          );

          // 5. 自动进澄清（best-effort，失败仅 log）
          try {
            await this.deps.transitionClarifying(autopilotReqId);
          } catch (e: unknown) {
            log.warn(
              "transitionClarifying 失败（继续）req=%s: %s",
              autopilotReqId,
              e instanceof Error ? e.message : String(e),
            );
          }

          // 6. 触发初始全量快照（让 reqgenie 侧立刻看到 clarifying 状态）
          this.deps.triggerSnapshot(autopilotReqId);

          log.info(
            "分配处理完成 assignment_id=%s autopilot_req_id=%s",
            assignment.assignment_id,
            autopilotReqId,
          );
        } catch (e: unknown) {
          log.error(
            "处理分配失败 assignment_id=%s: %s",
            assignment.assignment_id,
            e instanceof Error ? e.message : String(e),
          );
          // 不 ack → reqgenie 会超时重试（或人工处理）
          await this.sleep(base + Math.floor(Math.random() * base));
        }
      } catch (e: unknown) {
        if (!this.stopped) {
          log.warn(
            "claimAssignment 异常，退避重试：%s",
            e instanceof Error ? e.message : String(e),
          );
          await this.sleep(base + Math.floor(Math.random() * base));
        }
      }
    }
    log.info("assignments-poller 已停止");
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  dispose(): void {
    this.stopped = true;
  }
}
