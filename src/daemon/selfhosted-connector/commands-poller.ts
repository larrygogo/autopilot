/**
 * 命令轮询器（链路三）
 *
 * 长轮询 GET /commands/pending → 按 kind 映射本机 RPC apply → ack。
 * command_id 进程内幂等去重。best-effort：撞状态机失败 ack ok=false+reason，不阻塞。
 */

import { createLogger } from "../../core/logger";
import type { SelfhostedBackend } from "./backend";
import type { CommandKind, CommandAck } from "./types";

const log = createLogger("selfhosted:commands");

// ── RPC 函数签名（可 mock）────────────────────────────────────────

export interface CommandPollerRpcDeps {
  /** comments.add（answer_clarification / reject） */
  addComment(params: {
    requirementId: string;
    kind: "question" | "feedback" | "handoff";
    from_role: "user" | "agent" | "github";
    body: string;
    parent_id?: string | null;
  }): Promise<void>;

  /**
   * comments.resolve（answer_clarification 后 resolve 问题 → 触发 requirement:question-resolved → clarifier 续轮）
   */
  resolveComment(commentId: string): void;

  /** requirements.finishClarification */
  finishClarification(params: { id: string }): Promise<void>;

  /** requirements.retryClarify */
  retryClarify(params: { id: string }): Promise<void>;

  /** requirements.enqueue（approve） */
  enqueue(params: { id: string }): Promise<void>;

  /** requirements.cancel */
  cancel(params: { id: string; reason?: string }): Promise<void>;

  /** requirements.setWorkspaces（set_workspaces 命令） */
  setWorkspaces(params: { id: string; workspace_ids: string[] }): Promise<void>;
}

export interface CommandPollerDeps extends CommandPollerRpcDeps {
  backend: SelfhostedBackend;
  pollWaitSeconds: number;
  backoffBaseMs?: number;
  idleBackoffMs?: number;
}

export class CommandPoller {
  private stopped = false;
  /** 已 apply 的 command_id 集合（进程内幂等去重） */
  private readonly _applied = new Set<string>();

  constructor(private readonly deps: CommandPollerDeps) {}

  start(): void {
    log.info(
      "commands-poller 启动（pollWait=%ss）",
      this.deps.pollWaitSeconds,
    );
    void this.loop();
  }

  private async loop(): Promise<void> {
    const base = this.deps.backoffBaseMs ?? 3000;
    while (!this.stopped) {
      try {
        const cmd = await this.deps.backend.claimCommand(this.deps.pollWaitSeconds);
        if (!cmd) {
          await this.sleep(this.deps.idleBackoffMs ?? 250);
          continue;
        }

        // 幂等去重
        if (this._applied.has(cmd.command_id)) {
          log.info("命令已 apply（幂等跳过）command_id=%s", cmd.command_id);
          // 仍发 ack（防止对方无限重试）
          await this.deps.backend.ackCommand(cmd.command_id, { ok: true }).catch((e: unknown) => {
            log.warn("重复命令 ack 失败（忽略）command_id=%s: %s", cmd.command_id, e instanceof Error ? e.message : String(e));
          });
          continue;
        }

        log.info(
          "收到命令 command_id=%s kind=%s req=%s",
          cmd.command_id,
          cmd.kind,
          cmd.autopilot_req_id,
        );

        const ack = await this.applyCommand(
          cmd.kind,
          cmd.autopilot_req_id,
          cmd.payload,
        );

        // 标记已 apply（无论成功失败都标，防止撞状态机后重试导致双写）
        this._applied.add(cmd.command_id);

        try {
          await this.deps.backend.ackCommand(cmd.command_id, ack);
          log.info(
            "命令 ack command_id=%s ok=%s reason=%s",
            cmd.command_id,
            ack.ok,
            ack.reason ?? "",
          );
        } catch (e: unknown) {
          log.warn(
            "命令 ack 失败（已 apply，忽略 ack 错误）command_id=%s: %s",
            cmd.command_id,
            e instanceof Error ? e.message : String(e),
          );
        }
      } catch (e: unknown) {
        if (!this.stopped) {
          log.warn(
            "claimCommand 异常，退避重试：%s",
            e instanceof Error ? e.message : String(e),
          );
          await this.sleep(base + Math.floor(Math.random() * base));
        }
      }
    }
    log.info("commands-poller 已停止");
  }

  /**
   * 将命令 kind 映射到本机 RPC。
   * 任何 RpcError/状态机校验失败 → ack ok:false+reason（不重试）。
   */
  async applyCommand(
    kind: CommandKind,
    autopilotReqId: string,
    payload: Record<string, unknown>,
  ): Promise<CommandAck> {
    try {
      switch (kind) {
        case "answer_clarification": {
          const body = typeof payload.body === "string" ? payload.body.trim() : "";
          if (!body) return { ok: false, reason: "answer_clarification: body 必填" };
          const questionId = typeof payload.question_id === "string" ? payload.question_id : null;
          await this.deps.addComment({
            requirementId: autopilotReqId,
            kind: "question",
            from_role: "user",
            body,
            parent_id: questionId,
          });
          // resolve 问题本身 → 触发 requirement:question-resolved → clarifier 续轮
          if (questionId) {
            this.deps.resolveComment(questionId);
          }
          return { ok: true };
        }

        case "finish_clarification": {
          await this.deps.finishClarification({ id: autopilotReqId });
          return { ok: true };
        }

        case "retry_clarify": {
          await this.deps.retryClarify({ id: autopilotReqId });
          return { ok: true };
        }

        case "approve": {
          await this.deps.enqueue({ id: autopilotReqId });
          return { ok: true };
        }

        case "reject": {
          const body = typeof payload.body === "string" ? payload.body.trim() : "";
          if (!body) return { ok: false, reason: "reject: body 必填" };
          await this.deps.addComment({
            requirementId: autopilotReqId,
            kind: "feedback",
            from_role: "user",
            body,
          });
          return { ok: true };
        }

        case "accept": {
          // artifacts 验收（有交付 PR 时应去 GitHub merge，此处提示无法执行）
          log.info("accept 命令：req=%s（PR 路径需在 GitHub merge，签字唯一在 GitHub）", autopilotReqId);
          return { ok: true };
        }

        case "cancel": {
          const reason = typeof payload.reason === "string" ? payload.reason : undefined;
          await this.deps.cancel({ id: autopilotReqId, reason });
          return { ok: true };
        }

        case "set_workspaces": {
          const workspace_ids = Array.isArray(payload.workspace_ids)
            ? (payload.workspace_ids as unknown[]).filter((x): x is string => typeof x === "string")
            : [];
          await this.deps.setWorkspaces({ id: autopilotReqId, workspace_ids });
          return { ok: true };
        }

        default: {
          const _exhaust: never = kind;
          return { ok: false, reason: `未知命令 kind: ${_exhaust}` };
        }
      }
    } catch (e: unknown) {
      const reason = e instanceof Error ? e.message : String(e);
      log.warn(
        "命令 apply 失败 kind=%s req=%s: %s",
        kind,
        autopilotReqId,
        reason,
      );
      return { ok: false, reason };
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  dispose(): void {
    this.stopped = true;
  }
}
