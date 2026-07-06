/**
 * 镜像推送器（链路二）
 *
 * 订阅本机 event-bus，把需求相关事件翻译成 mirror 事件推给 reqgenie。
 * 全量快照在：拉到分配 / daemon 重启 / 409 seq-gap 时触发。
 * 仅处理 source=reqgenie 的需求（per-link 维护 mirror_seq 单调递增）。
 * best-effort：推送失败只 warn，不阻塞需求推进。
 */

import { createLogger } from "../../core/logger";
import { onEvent as coreOnEvent, offEvent } from "../../core/event-bus";
import type { AutopilotEvent } from "../../core/events";
import type { SelfhostedBackend } from "./backend";
import type { MirrorEvent, MirrorSnapshot, ReqLink } from "./types";

const log = createLogger("selfhosted:mirror");

// ── 依赖注入接口（便于测试 mock）────────────────────────────────

export interface MirrorPusherDeps {
  backend: SelfhostedBackend;

  /** 读取需求完整状态（用于全量快照） */
  getRequirement(id: string): RequirementSnapshot | null;

  /** 读取需求的澄清问答列表（全量快照用） */
  listComments(requirementId: string): CommentSnapshot[];

  /** 读取需求的 sub_prs 列表（全量快照用） */
  listSubPrs(requirementId: string): SubPrSnapshot[];

  /** 读取需求的活跃运行的执行阶段（phase events） */
  listPhaseEvents(requirementId: string): PhaseEventSnapshot[];

  /**
   * 事件订阅函数（可选，默认回退到 core/event-bus 的 onEvent）。
   * 宿主（ExtensionContext）注入此字段时，其 ctx.on 会追踪所有 handler，
   * dispose 时统一 offEvent，扩展无需手动清理。
   * 独立测试时注入 mock 函数即可不依赖全局 event-bus。
   * 不传时回退到 core 的 onEvent（保持与现有测试的向后兼容）。
   */
  onEvent?: (type: string, handler: (event: AutopilotEvent) => void) => void;

  /**
   * 事件取消订阅函数（可选，默认回退到 core/event-bus 的 offEvent）。
   * 测试时与 onEvent 配套注入，保证 dispose() 能正确追踪清理。
   * 不传时回退到 core 的 offEvent（生产行为不变）。
   */
  offEvent?: (type: string, handler: (event: AutopilotEvent) => void) => void;
}

export interface RequirementSnapshot {
  id: string;
  title: string | null;
  status: string;
  spec_md: string;
  status_reason: string | null;
  source?: string | null;
  external_ref?: string | null;
}

export interface CommentSnapshot {
  id: string;
  parent_id: string | null;
  from_role: string;
  body: string;
  status: string;
  created_at: number;
  suggestions: string[] | null;
  kind: string;
}

export interface SubPrSnapshot {
  repo_alias: string;
  pr_url: string;
  pr_state: string;
  last_reviewed_event_id: string | null;
}

export interface PhaseEventSnapshot {
  run_seq: number;
  phase: string;
  label: string;
  state: string;
  started_at: string | null;
  ended_at: string | null;
  seq: number;
  run_kind?: string;
}

// ── 推送器主体 ─────────────────────────────────────────────────

export class MirrorPusher {
  /** reqgenie_req_id → ReqLink（含 mirror_seq）*/
  private readonly _links = new Map<string, ReqLink>();
  /** autopilot_req_id → ReqLink（反查用）*/
  private readonly _byAutopilotId = new Map<string, ReqLink>();

  /** 挂起的批量事件队列（按 autopilot_req_id 分桶，批量刷新） */
  private readonly _pending = new Map<string, MirrorEvent[]>();
  private _flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly FLUSH_DEBOUNCE_MS = 200;

  /** phase/pr 变化触发的全量快照防抖计时器（按 autopilot_req_id 分桶） */
  private readonly _snapshotDebounce = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly SNAPSHOT_DEBOUNCE_MS = 300;

  /**
   * start() 时绑定的事件处理器（已修复 .bind() 每次创建新对象导致 offEvent 无效的旧 bug）。
   * dispose() 用同一批对象调 offEvent，保证能正确移除监听。
   */
  private _boundHandlers: Array<[string, (e: AutopilotEvent) => void]> = [];

  constructor(private readonly deps: MirrorPusherDeps) {}

  /** 注册新 link（建需求成功后由 assignments-poller 调用） */
  registerLink(link: ReqLink): void {
    this._links.set(link.reqgenie_req_id, link);
    this._byAutopilotId.set(link.autopilot_req_id, link);
    log.info(
      "注册 mirror link reqgenie_req_id=%s autopilot_req_id=%s",
      link.reqgenie_req_id,
      link.autopilot_req_id,
    );
  }

  /**
   * 启动事件订阅。
   * 优先使用 deps.onEvent（宿主注入时追踪所有 handler，dispose 时统一 offEvent）；
   * 未注入时回退到 core/event-bus 的 coreOnEvent（保持与现有测试向后兼容）。
   */
  start(): void {
    const onEventFn = this.deps.onEvent ?? coreOnEvent;
    this._boundHandlers = [];
    for (const [type, handler] of SUBSCRIPTIONS) {
      const bound = handler.bind(this) as (e: AutopilotEvent) => void;
      this._boundHandlers.push([type, bound]);
      onEventFn(type, bound);
    }
    log.info("mirror-pusher 已启动（订阅需求全状态事件）");
  }

  /**
   * 停止并清理。
   * 调用 offEvent 使用 start() 时保存的同一批绑定函数（修复旧实现 .bind() 对象不同无法 remove 的 bug）。
   * 若宿主已通过 ctx.on 追踪并提前 offEvent，重复调用为 no-op（EventEmitter.off 幂等）。
   */
  dispose(): void {
    const offEventFn = this.deps.offEvent ?? offEvent;
    for (const [type, handler] of this._boundHandlers) {
      offEventFn(type, handler);
    }
    this._boundHandlers = [];
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    for (const timer of this._snapshotDebounce.values()) {
      clearTimeout(timer);
    }
    this._snapshotDebounce.clear();
    this._links.clear();
    this._byAutopilotId.clear();
    this._pending.clear();
    log.info("mirror-pusher 已停止");
  }

  // ── 全量快照 ──────────────────────────────────────────────────

  /** 向 reqgenie 推全量快照，重置 seq 基线 */
  async pushSnapshot(autopilotReqId: string): Promise<void> {
    const link = this._byAutopilotId.get(autopilotReqId);
    if (!link) return;

    const req = this.deps.getRequirement(autopilotReqId);
    if (!req) return;

    const comments = this.deps.listComments(autopilotReqId);
    const subPrs = this.deps.listSubPrs(autopilotReqId);
    const phases = this.deps.listPhaseEvents(autopilotReqId);

    const snapshot: MirrorSnapshot = {
      autopilot_req_id: autopilotReqId,
      mirror_status: req.status,
      status_reason: req.status_reason,
      spec_md: req.spec_md,
      title: req.title,
      questions: comments
        .filter((c) => c.from_role === "agent" || c.from_role === "user" || c.from_role === "github")
        .map((c, i) => ({
          autopilot_question_id: c.id,
          parent_id: c.parent_id,
          from_role: c.from_role,
          body: c.body,
          status: (c.status === "resolved" ? "resolved" : "open") as "open" | "resolved",
          seq: i,
          suggestions: c.suggestions ?? null,
          kind: c.kind,
        })),
      phases: phases.map((p) => ({
        run_seq: p.run_seq,
        phase: p.phase,
        label: p.label,
        status: p.state as MirrorPhaseState,
        started_at: p.started_at,
        finished_at: p.ended_at,
        seq: p.seq,
        run_kind: p.run_kind,
      })),
      prs: subPrs.map((sp, i) => ({
        repo_alias: sp.repo_alias,
        pr_url: sp.pr_url,
        pr_status: sp.pr_state ?? "open",
        seq: i,
      })),
    };

    try {
      await this.deps.backend.postMirrorSnapshot(snapshot);
      // 重置 seq 基线（snapshot 后 reqgenie 侧接受任意新 seq 从 0 开始）
      link.mirror_seq = 0;
      log.info("全量快照推送成功 req=%s", autopilotReqId);
    } catch (e: unknown) {
      log.warn(
        "全量快照推送失败（忽略）req=%s: %s",
        autopilotReqId,
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  // ── 增量事件入队 ──────────────────────────────────────────────

  /** 将一个 mirror 事件入队（按 autopilot_req_id 分桶，防抖批量刷新） */
  private enqueue(autopilotReqId: string, type: MirrorEvent["type"], payload: Record<string, unknown>): void {
    const link = this._byAutopilotId.get(autopilotReqId);
    if (!link) return;

    if (!this._pending.has(autopilotReqId)) {
      this._pending.set(autopilotReqId, []);
    }

    link.mirror_seq += 1;
    const event: MirrorEvent = {
      mirror_seq: link.mirror_seq,
      type,
      payload,
    };
    this._pending.get(autopilotReqId)!.push(event);
    this.scheduledFlush();
  }

  private scheduledFlush(): void {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      void this.flushAll();
    }, this.FLUSH_DEBOUNCE_MS);
  }

  private async flushAll(): Promise<void> {
    for (const [reqId, events] of this._pending.entries()) {
      if (events.length === 0) continue;
      const toSend = [...events];
      this._pending.delete(reqId);

      try {
        const result = await this.deps.backend.postMirrorEvents(toSend, reqId);
        if (result.seqGap) {
          log.warn("mirror events seq-gap 检测到，触发全量快照 req=%s", reqId);
          void this.pushSnapshot(reqId);
        }
      } catch (e: unknown) {
        log.warn(
          "mirror events 推送失败（忽略）req=%s events=%d: %s",
          reqId,
          toSend.length,
          e instanceof Error ? e.message : String(e),
        );
      }
    }
  }

  /**
   * 防抖触发全量快照推送（phase/PR 变化专用）。
   * 同一需求短时间内的多个 phase 事件合并成一次 pushSnapshot，避免快照风暴。
   */
  private scheduleSnapshot(autopilotReqId: string): void {
    const existing = this._snapshotDebounce.get(autopilotReqId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this._snapshotDebounce.delete(autopilotReqId);
      void this.pushSnapshot(autopilotReqId);
    }, this.SNAPSHOT_DEBOUNCE_MS);
    this._snapshotDebounce.set(autopilotReqId, timer);
  }

  // ── 懒注册自愈 ───────────────────────────────────────────────

  /**
   * 检查 autopilotReqId 是否已有 link 映射；若无，尝试从 DB 懒加载并注册。
   * 仅对 source=reqgenie 的需求注册（非 reqgenie 需求直接返回 false）。
   * 注册成功后 fire-and-forget 一次全量快照重置基线。
   * 返回 true 表示链路可用，false 表示无需处理（非 reqgenie 或无外部引用）。
   */
  private ensureRegistered(autopilotReqId: string): boolean {
    if (this._byAutopilotId.has(autopilotReqId)) return true;
    const req = this.deps.getRequirement(autopilotReqId);
    if (req?.source === "reqgenie" && req.external_ref) {
      this.registerLink({
        reqgenie_req_id: req.external_ref,
        autopilot_req_id: autopilotReqId,
        assignment_id: "",   // 懒注册无原始 assignment_id，填空串（link 仅用 reqgenie_req_id 做 key）
        mirror_seq: 0,
      });
      void this.pushSnapshot(autopilotReqId);  // fire-and-forget 基线全量快照
      return true;
    }
    return false;
  }

  // ── event-bus 事件处理 ────────────────────────────────────────

  handleStatusChanged(event: AutopilotEvent): void {
    if (event.type !== "requirement:status-changed") return;
    const { id, to, reason } = event.payload;
    if (!this.ensureRegistered(id)) return;
    // reqgenie ingest_mirror_events 读取 payload.status（非 from/to）
    this.enqueue(id, "status_changed", {
      status: to,
      status_reason: reason ?? null,
    });
  }

  /** 构建 clarify_updated 事件的 questions 数组（与 snapshot questions 同形状） */
  private buildQuestionsPayload(requirementId: string): Record<string, unknown> {
    const comments = this.deps.listComments(requirementId);
    const questions = comments
      .filter((c) => c.from_role === "agent" || c.from_role === "user" || c.from_role === "github")
      .map((c, i) => ({
        autopilot_question_id: c.id,
        parent_id: c.parent_id,
        from_role: c.from_role,
        body: c.body,
        status: (c.status === "resolved" ? "resolved" : "open") as "open" | "resolved",
        seq: i,
        suggestions: c.suggestions ?? null,
        kind: c.kind,
      }));
    return { questions };
  }

  handleQuestionsUpdated(event: AutopilotEvent): void {
    if (event.type !== "requirement:questions-updated") return;
    const { id } = event.payload;
    if (!this.ensureRegistered(id)) return;
    // reqgenie clarify_updated 协议要求 payload.questions[] 包含完整问题列表
    this.enqueue(id, "clarify_updated", this.buildQuestionsPayload(id));
  }

  handleQuestionResolved(event: AutopilotEvent): void {
    if (event.type !== "requirement:question-resolved") return;
    const { id } = event.payload;
    if (!this.ensureRegistered(id)) return;
    // 问题解答后同步最新问题列表（含已 resolved 状态）
    this.enqueue(id, "clarify_updated", this.buildQuestionsPayload(id));
  }

  handleActiveQuestionChanged(event: AutopilotEvent): void {
    if (event.type !== "requirement:active-question-changed") return;
    const { id } = event.payload;
    if (!this.ensureRegistered(id)) return;
    // 活跃问题切换时同步最新问题列表
    this.enqueue(id, "clarify_updated", this.buildQuestionsPayload(id));
  }

  handleSpecRevised(event: AutopilotEvent): void {
    if (event.type !== "requirement:spec-revised") return;
    const { id } = event.payload;
    if (!this.ensureRegistered(id)) return;
    // reqgenie spec_revised 协议要求 payload.spec_md（非 revision_id）
    const req = this.deps.getRequirement(id);
    this.enqueue(id, "spec_revised", { spec_md: req?.spec_md ?? null });
  }

  handleClarifierRoundUpdate(event: AutopilotEvent): void {
    if (event.type !== "requirement:clarifier-round-update") return;
    const payload = event.payload as unknown as Record<string, unknown>;
    const reqId = typeof payload["requirement_id"] === "string" ? payload["requirement_id"] : null;
    if (!reqId || !this.ensureRegistered(reqId)) return;
    this.enqueue(reqId, "clarify_progress", {
      round: payload["round"],
      status: payload["status"],
    });
  }

  handlePhaseStarted(event: AutopilotEvent): void {
    if (event.type !== "phase:started") return;
    const { taskId } = event.payload;
    const link = this.resolveByTaskId(taskId);
    if (!link) return;
    this.scheduleSnapshot(link.autopilot_req_id);
  }

  handlePhaseCompleted(event: AutopilotEvent): void {
    if (event.type !== "phase:completed") return;
    const { taskId } = event.payload;
    const link = this.resolveByTaskId(taskId);
    if (!link) return;
    this.scheduleSnapshot(link.autopilot_req_id);
  }

  handlePhaseAwaiting(event: AutopilotEvent): void {
    if (event.type !== "phase:awaiting") return;
    const { taskId } = event.payload;
    const link = this.resolveByTaskId(taskId);
    if (!link) return;
    this.scheduleSnapshot(link.autopilot_req_id);
  }

  handlePhaseError(event: AutopilotEvent): void {
    if (event.type !== "phase:error") return;
    const { taskId } = event.payload;
    const link = this.resolveByTaskId(taskId);
    if (!link) return;
    this.scheduleSnapshot(link.autopilot_req_id);
  }

  handleTaskTransition(event: AutopilotEvent): void {
    if (event.type !== "task:transition") return;
    const { taskId } = event.payload;
    const link = this.resolveByTaskId(taskId);
    if (!link) return;
    this.scheduleSnapshot(link.autopilot_req_id);
  }

  // ── task_id → ReqLink 的反查辅助 ──────────────────────────────
  // 注：task:* 事件只有 taskId，需要反查 requirement_id → link。
  // 这里通过注入的 getTaskRequirementId 来解析。

  private _taskReqMap = new Map<string, string>();

  /** 供外部（index.ts 的 task:created/updated 订阅）通知任务归属 */
  registerTaskRequirement(taskId: string, requirementId: string): void {
    this._taskReqMap.set(taskId, requirementId);
  }

  private resolveByTaskId(taskId: string): ReqLink | undefined {
    const reqId = this._taskReqMap.get(taskId);
    if (!reqId) return undefined;
    this.ensureRegistered(reqId);  // 懒注册：_taskReqMap 有 reqId 但 _byAutopilotId 中无映射时自愈
    return this._byAutopilotId.get(reqId);
  }
}

type MirrorPhaseState = "pending" | "running" | "awaiting" | "completed" | "error" | "aborted";

// ── 事件订阅绑定表（按 mirror-pusher 实例方法绑定）─────────────

type HandlerMethod = (event: AutopilotEvent) => void;
type HandlerEntry = [string, (this: MirrorPusher, event: AutopilotEvent) => void];

const SUBSCRIPTIONS: HandlerEntry[] = [
  ["requirement:status-changed", MirrorPusher.prototype.handleStatusChanged],
  ["requirement:questions-updated", MirrorPusher.prototype.handleQuestionsUpdated],
  ["requirement:question-resolved", MirrorPusher.prototype.handleQuestionResolved],
  ["requirement:active-question-changed", MirrorPusher.prototype.handleActiveQuestionChanged],
  ["requirement:spec-revised", MirrorPusher.prototype.handleSpecRevised],
  ["requirement:clarifier-round-update", MirrorPusher.prototype.handleClarifierRoundUpdate],
  ["phase:started", MirrorPusher.prototype.handlePhaseStarted],
  ["phase:completed", MirrorPusher.prototype.handlePhaseCompleted],
  ["phase:awaiting", MirrorPusher.prototype.handlePhaseAwaiting],
  ["phase:error", MirrorPusher.prototype.handlePhaseError],
  ["task:transition", MirrorPusher.prototype.handleTaskTransition],
];

// 导出 HandlerMethod 类型供测试使用
export type { HandlerMethod };
