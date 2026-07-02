/**
 * reqgenie-connector 扩展实现
 *
 * 实现 Extension 接口，将原 initSelfhostedConnector() 的装配逻辑迁移到
 * ExtensionContext API 上：所有 core/daemon 访问通过 ctx.read.* / ctx.act.*，
 * 事件订阅通过 ctx.on（宿主统一 offEvent 清理）。
 *
 * 行为与原 initSelfhostedConnector() 完全一致：
 *   - enabled()：config.selfhosted.enabled + 有落盘凭证
 *   - init(ctx)：backend + MirrorPusher + AssignmentPoller + CommandPoller + 心跳 + 启动恢复
 *   - dispose()：clearInterval + poller.dispose + mirrorPusher.dispose（事件清理由宿主接管）
 */

import { loadSelfhostedConfig, saveSelfhostedConfig } from "../../core/config";
import { loadSelfhostedCredentials, saveSelfhostedCredentials, clearSelfhostedCredentials } from "./credentials";
import { startExtension, stopExtension } from "../extensions/registry";
import { SelfhostedBackend } from "./backend";
import { AssignmentPoller } from "./assignments-poller";
import { CommandPoller } from "./commands-poller";
import { MirrorPusher } from "./mirror-pusher";
import { recoverInflightLinks } from "./index";
import { DEFAULT_PROJECT_ID } from "../../core/projects";
import type { AutopilotEvent } from "../../core/events";
import type { Extension, ExtensionContext } from "../extensions/context";
import type { ReqLink } from "./types";

// ── 模块级清理句柄（支持多次 init/dispose 轮回，如 daemon.restart）───────

let _disposeConnector: (() => void) | null = null;

// ── 心跳健康态（status() 报告用）─────────────────────────────────────────

let _lastHeartbeatAt: number | null = null;
let _lastHeartbeatOk: boolean | null = null;

// ── 扩展实现 ───────────────────────────────────────────────────────────────

/** reqgenie B-interactive 连接器扩展（单例，由 daemon/index.ts 通过 registerExtension 注册）。 */
export const reqgenieExtension: Extension = {
  id: "reqgenie-connector",

  enabled(): boolean {
    const cfg = loadSelfhostedConfig();
    if (!cfg.enabled) return false;
    return loadSelfhostedCredentials() !== null;
  },

  status(): Record<string, unknown> {
    const creds = loadSelfhostedCredentials();
    if (!creds) return { 注册状态: "未注册" };
    return {
      注册状态: "已注册（reqgenie 实例）",
      实例ID: creds.instance_id,
      控制面: creds.control_plane_url,
      连接: _lastHeartbeatOk === null ? "等待心跳" : _lastHeartbeatOk ? "正常" : "失联",
      最近心跳: _lastHeartbeatAt ? new Date(_lastHeartbeatAt).toLocaleString("zh-CN", { hour12: false }) : "—",
    };
  },

  async invoke(action: string, params: Record<string, unknown>): Promise<unknown> {
    if (action === "register") {
      const url = typeof params.control_plane_url === "string" ? params.control_plane_url.trim() : "";
      const token = typeof params.token === "string" ? params.token.trim() : "";
      const name =
        typeof params.name === "string" && params.name.trim()
          ? params.name.trim()
          : (process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "autopilot-instance");
      if (!url) throw new Error("控制面 URL 必填");
      if (!token) throw new Error("注册令牌必填");
      if (loadSelfhostedCredentials()) {
        throw new Error("本机已注册；先运行 `autopilot selfhosted remove` 下线后再重新注册");
      }

      const { instance_id, secret } = await SelfhostedBackend.register(url, token, name);
      const controlPlaneUrl = url.replace(/\/+$/, "");
      saveSelfhostedCredentials({ control_plane_url: controlPlaneUrl, instance_id, secret });
      saveSelfhostedConfig({
        ...loadSelfhostedConfig(),
        control_plane_url: controlPlaneUrl,
        enabled: true,
      });

      // 热启动连接器（凭证已就绪、enabled()=true），不必重启 daemon
      startExtension("reqgenie-connector");
      return { instance_id, name };
    }

    if (action === "remove") {
      if (!loadSelfhostedCredentials()) throw new Error("本机未注册 selfhosted 实例");
      // 先停运行中的连接器（dispose 内 best-effort 向 reqgenie 发 deregister，此刻凭证仍在内存）
      stopExtension("reqgenie-connector");
      const removed = clearSelfhostedCredentials();
      saveSelfhostedConfig({ ...loadSelfhostedConfig(), enabled: false });
      _lastHeartbeatAt = null;
      _lastHeartbeatOk = null;
      return { removed };
    }

    throw new Error(`未知动作: ${action}`);
  },

  init(ctx: ExtensionContext): void {
    const creds = loadSelfhostedCredentials();
    if (!creds) {
      // enabled() 已过滤，此处为保险检查
      ctx.log.warn("reqgenie-connector: init 时凭证已失效，跳过");
      return;
    }

    ctx.log.info(
      "selfhosted connector 启动 instance_id=%s control_plane=%s",
      creds.instance_id,
      creds.control_plane_url,
    );

    const backend = new SelfhostedBackend(creds);

    // ── MirrorPusher ──────────────────────────────────────────────────────
    const mirrorPusher = new MirrorPusher({
      backend,

      getRequirement: (id) => {
        const req = ctx.read.requirement(id);
        if (!req) return null;
        return {
          id: req.id,
          title: req.title,
          status: req.status,
          spec_md: req.spec_md,
          status_reason: req.status_reason ?? null,
          source: req.source ?? null,
          external_ref: req.external_ref ?? null,
        };
      },

      listComments: (requirementId) =>
        ctx.read.comments(requirementId).map((c) => ({
          id: c.id,
          parent_id: c.parent_id,
          kind: c.kind,
          from_role: c.from_role,
          body: c.body,
          status: c.status,
          created_at: c.created_at,
          suggestions: c.suggestions ?? null,
        })),

      listSubPrs: (requirementId) =>
        ctx.read.subPrs(requirementId).map((sp) => ({
          repo_alias: sp.child_workspace_id,
          pr_url: sp.pr_url ?? "",
          pr_state: "open",               // sub_pr 无 pr_state 列，默认 open
          last_reviewed_event_id: sp.last_reviewed_event_id ?? null,
        })),

      // PhaseEventEntry（context.ts）与 PhaseEventSnapshot（mirror-pusher.ts）形状兼容（结构类型）
      listPhaseEvents: (requirementId) => ctx.read.phaseEvents(requirementId),

      // 事件订阅经 ctx.on：宿主追踪 handler、dispose 时统一 offEvent
      onEvent: (type, handler) => ctx.on(type, handler),
    });
    mirrorPusher.start();

    // ── task:created/updated 维护 taskId → requirementId 反查表 ──────────
    ctx.on("task:created", (event: AutopilotEvent) => {
      if (event.type !== "task:created") return;
      const { task } = event.payload;
      if (task.requirement_id) {
        mirrorPusher.registerTaskRequirement(task.id, task.requirement_id);
      }
    });
    ctx.on("task:updated", (event: AutopilotEvent) => {
      if (event.type !== "task:updated") return;
      const { task } = event.payload;
      if (task.requirement_id) {
        mirrorPusher.registerTaskRequirement(task.id, task.requirement_id);
      }
    });

    // ── AssignmentPoller ──────────────────────────────────────────────────
    const assignmentPoller = new AssignmentPoller({
      backend,
      pollWaitSeconds: 50,

      async createRequirement(params) {
        const projectId = params.project_id ?? DEFAULT_PROJECT_ID;
        return ctx.act.createRequirement({
          project_id: projectId,
          workspace_id: null,
          title: params.title,
          spec_md: params.spec_md,
          source: params.source,
          external_ref: params.external_ref,
          callback_url: null,
          callback_secret: null,
          chat_session_id: null,
        });
      },

      async setWorkspaces({ autopilot_req_id, repo_urls }) {
        const req = ctx.read.requirement(autopilot_req_id);
        if (!req) return;
        const wsIds = await ctx.act.resolveWorkspacesByUrls(req.project_id, repo_urls);
        if (wsIds.length > 0) {
          ctx.act.setWorkspaces(autopilot_req_id, wsIds);
        }
      },

      onLinkCreated(link: ReqLink) {
        mirrorPusher.registerLink(link);
      },

      async transitionClarifying(autopilotReqId: string) {
        ctx.act.setStatus(autopilotReqId, "clarifying");
      },

      triggerSnapshot(autopilotReqId: string) {
        void mirrorPusher.pushSnapshot(autopilotReqId);
      },
    });
    assignmentPoller.start();

    // ── CommandPoller ─────────────────────────────────────────────────────
    const commandPoller = new CommandPoller({
      backend,
      pollWaitSeconds: 50,

      async addComment({ requirementId, kind, from_role, body, parent_id }) {
        ctx.act.addComment({
          requirement_id: requirementId,
          kind,
          from_role,
          body,
          parent_id: parent_id ?? null,
        });
        // 状态机副作用（业务逻辑保留在插件内，不污染 ctx.act.addComment 本身）
        const req = ctx.read.requirement(requirementId);
        if (kind === "feedback" && req?.status === "awaiting_review") {
          ctx.act.setStatus(requirementId, "fix_revision");
        } else if (kind === "feedback" && req?.status === "awaiting_approval") {
          // 审批驳回：spec 被驳回 → 回澄清重做（clarifier 经 status-changed 自动续轮、读到反馈）
          ctx.act.setStatus(requirementId, "clarifying");
        }
      },

      resolveComment(commentId: string) {
        ctx.act.resolveComment(commentId);
      },

      async finishClarification({ id }) {
        ctx.act.finishClarification(id);
      },

      async retryClarify({ id }) {
        await ctx.act.retryClarify(id);
      },

      async enqueue({ id }) {
        ctx.act.setStatus(id, "queued");
      },

      async cancel({ id }) {
        ctx.act.cancelRequirement(id);
      },

      async setWorkspaces({ id, workspace_ids }) {
        ctx.act.setWorkspaces(id, workspace_ids);
      },
    });
    commandPoller.start();

    // ── 心跳（成败记录进模块态，供 status() 报告连接健康）────────────────
    const HEARTBEAT_MS = 30_000;
    const heartbeatTimer = setInterval(() => {
      backend.heartbeat()
        .then(() => {
          _lastHeartbeatAt = Date.now();
          _lastHeartbeatOk = true;
        })
        .catch((e: unknown) => {
          _lastHeartbeatAt = Date.now();
          _lastHeartbeatOk = false;
          ctx.log.warn("selfhosted 心跳失败：%s", e instanceof Error ? e.message : String(e));
        });
    }, HEARTBEAT_MS);

    // ── 启动恢复（best-effort，不阻塞启动）──────────────────────────────
    // daemon 重启时内存映射丢失，从本机 DB 重建进行中需求的 mirror 链接 + 补推快照
    void recoverInflightLinks(mirrorPusher);

    ctx.log.info("selfhosted connector 已启动");

    // ── 注册清理函数（供 dispose() 使用）───────────────────────────────
    _disposeConnector = () => {
      clearInterval(heartbeatTimer);
      assignmentPoller.dispose();
      commandPoller.dispose();
      // mirrorPusher.dispose() 清定时器 + 清 map + offEvent 已注册的事件
      // （宿主通过 ctx.on 追踪的 handler 也会由宿主统一 offEvent，双清无害）
      mirrorPusher.dispose();
      backend.deregister().catch(() => {/* 下线 best-effort */});
      ctx.log.info("selfhosted connector 已停止");
    };
  },

  dispose(): void {
    if (_disposeConnector) {
      _disposeConnector();
      _disposeConnector = null;
    }
  },
};
