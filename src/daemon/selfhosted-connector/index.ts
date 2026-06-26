/**
 * selfhosted-connector 装配入口
 *
 * 标准 daemon 启动后，若 config.selfhosted.enabled=true 且有落盘凭证，
 * 则初始化此连接器：心跳 + assignments 轮询 + commands 轮询 + mirror 推送。
 * 仿 initSelfhostedMirror 的挂载/卸载模式——不影响 daemon 其余逻辑。
 */

import { createLogger } from "../../core/logger";
import { loadSelfhostedConfig } from "../../core/config";
import { loadSelfhostedCredentials } from "./credentials";
import { SelfhostedBackend } from "./backend";
import { AssignmentPoller } from "./assignments-poller";
import { CommandPoller } from "./commands-poller";
import { MirrorPusher } from "./mirror-pusher";
import { onEvent, offEvent } from "../../core/event-bus";
import type { AutopilotEvent } from "../../core/events";
import type { ReqLink } from "./types";

// 本机 RPC 直接调（in-process，无 HTTP 往返）
import { getRequirementById, createRequirement as coreCreateRequirement } from "../../core/requirements";
import { listComments, createComment, nextCommentId, resolveComment } from "../../core/requirements/comments";
import { listSubPrs } from "../../core/requirements/sub-prs";
import { listTasksByRequirement, listTaskPhaseEvents, getDb } from "../../core/db";
import {
  setRequirementStatus,
  finishClarification as coreFinishClarification,
  setRequirementWorkspaces,
} from "../../core/requirements";
import { cancelRequirementWithTasks } from "../../daemon/task-actions";
import {
  createWorkspace,
  nextWorkspaceId,
  listWorkspaces,
} from "../../core/sandbox/workspaces";
import { loadGitConfig } from "../../core/config";
import { probeRemote, parseGithubFromRemote } from "../../core/sandbox/workspace-health";
import { DEFAULT_PROJECT_ID } from "../../core/projects";
import { runClarifierRound } from "../../daemon/requirement-clarifier";

const log = createLogger("selfhosted:connector");

// ── 全局单例（便于 dispose 清理）────────────────────────────

let _backend: SelfhostedBackend | null = null;
let _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let _assignmentPoller: AssignmentPoller | null = null;
let _commandPoller: CommandPoller | null = null;
let _mirrorPusher: MirrorPusher | null = null;
let _taskCreatedHandler: ((e: AutopilotEvent) => void) | null = null;
let _taskUpdatedHandler: ((e: AutopilotEvent) => void) | null = null;

// ── 本机 workspace 解析 ───────────────────────────────────────

/**
 * 把 repo_urls 数组中每个 URL 映射到本机已注册的 workspace_id。
 * 若某 URL 尚未注册，尝试创建（探测可达性；失败跳过 warn）。
 * 返回成功映射的 workspace_ids 数组。
 */
async function resolveWorkspaceIds(
  projectId: string,
  repoUrls: string[],
): Promise<string[]> {
  if (repoUrls.length === 0) return [];

  const existing = listWorkspaces().filter((w) => w.project_id === projectId);
  const result: string[] = [];
  const gitCfg = loadGitConfig();

  for (const url of repoUrls) {
    const found = existing.find((w) => w.remote_url === url);
    if (found) {
      result.push(found.id);
      continue;
    }

    // 尝试创建新 workspace
    try {
      const probe = probeRemote(url, gitCfg.token);
      if (!probe.ok) {
        log.warn("repo_url 不可达（跳过）: %s", url);
        continue;
      }
      const parsed = parseGithubFromRemote(url);
      const alias = parsed?.repo ?? url.split("/").pop()?.replace(/\.git$/, "") ?? "repo";
      const ws = createWorkspace({
        id: nextWorkspaceId(),
        project_id: projectId,
        alias,
        remote_url: url,
        default_branch: probe.defaultBranch ?? "main",
        github_owner: parsed?.owner ?? null,
        github_repo: parsed?.repo ?? null,
      });
      result.push(ws.id);
      log.info("自动注册 workspace alias=%s url=%s id=%s", alias, url, ws.id);
    } catch (e: unknown) {
      log.warn(
        "自动注册 workspace 失败（跳过）url=%s: %s",
        url,
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  return result;
}

// ── 初始化入口 ────────────────────────────────────────────────

export function initSelfhostedConnector(): () => void {
  const cfg = loadSelfhostedConfig();
  if (!cfg.enabled) {
    log.info("selfhosted connector 未启用（config.selfhosted.enabled=false），跳过");
    return () => {};
  }

  const creds = loadSelfhostedCredentials();
  if (!creds) {
    log.info("selfhosted connector 无凭证（未注册），跳过");
    return () => {};
  }

  log.info(
    "selfhosted connector 启动 instance_id=%s control_plane=%s",
    creds.instance_id,
    creds.control_plane_url,
  );

  const backend = new SelfhostedBackend(creds);
  _backend = backend;

  // ── mirror pusher ──────────────────────────────────────────
  const mirrorPusher = new MirrorPusher({
    backend,
    getRequirement: (id) => {
      const req = getRequirementById(id);
      if (!req) return null;
      return {
        id: req.id,
        title: req.title,
        status: req.status,
        spec_md: req.spec_md,
        status_reason: req.status_reason,
      };
    },
    listComments: (requirementId) => {
      const comments = listComments(requirementId, {});
      return comments.map((c) => ({
        id: c.id,
        parent_id: c.parent_id,
        from_role: c.from_role,
        body: c.body,
        status: c.status,
        created_at: c.created_at,
      }));
    },
    listSubPrs: (requirementId) => {
      const subPrs = listSubPrs(requirementId);
      return subPrs.map((sp) => ({
        repo_alias: sp.child_workspace_id,   // 用 workspace_id 作 alias（无 alias 字段）
        pr_url: sp.pr_url ?? "",
        pr_state: "open",                    // sub_pr 无 pr_state 列，默认 open
        last_reviewed_event_id: sp.last_reviewed_event_id ?? null,
      }));
    },
    listPhaseEvents: (requirementId) => {
      // 找该需求最新 run 的 task_id
      const tasks = listTasksByRequirement(requirementId);
      if (tasks.length === 0) return [];
      const latestTask = tasks.reduce((a, b) => (a.created_at > b.created_at ? a : b));
      const phaseEvents = listTaskPhaseEvents(latestTask.id);
      return phaseEvents.map((pe, i) => ({
        run_seq: i,
        phase: pe.phase,
        label: pe.phase,
        state: pe.status === "done" ? "completed" : pe.status,
        started_at: pe.started_at ? new Date(pe.started_at).toISOString() : null,
        ended_at: pe.ended_at ? new Date(pe.ended_at).toISOString() : null,
        seq: pe.id,
      }));
    },
  });
  _mirrorPusher = mirrorPusher;
  mirrorPusher.start();

  // 订阅 task:created/updated 以维护 taskId → requirementId 反查表
  const taskCreatedHandler = (event: AutopilotEvent) => {
    if (event.type !== "task:created") return;
    const { task } = event.payload;
    if (task.requirement_id) {
      mirrorPusher.registerTaskRequirement(task.id, task.requirement_id);
    }
  };
  const taskUpdatedHandler = (event: AutopilotEvent) => {
    if (event.type !== "task:updated") return;
    const { task } = event.payload;
    if (task.requirement_id) {
      mirrorPusher.registerTaskRequirement(task.id, task.requirement_id);
    }
  };
  onEvent("task:created", taskCreatedHandler);
  onEvent("task:updated", taskUpdatedHandler);
  _taskCreatedHandler = taskCreatedHandler;
  _taskUpdatedHandler = taskUpdatedHandler;

  // ── assignments poller ──────────────────────────────────────
  const assignmentPoller = new AssignmentPoller({
    backend,
    pollWaitSeconds: 50,
    async createRequirement(params) {
      const projectId = params.project_id ?? DEFAULT_PROJECT_ID;
      const created = coreCreateRequirement({
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
      return created.id;
    },
    async setWorkspaces({ autopilot_req_id, repo_urls }) {
      const req = getRequirementById(autopilot_req_id);
      if (!req) return;
      const wsIds = await resolveWorkspaceIds(req.project_id, repo_urls);
      if (wsIds.length > 0) {
        setRequirementWorkspaces(autopilot_req_id, wsIds);
      }
    },
    onLinkCreated(link: ReqLink) {
      mirrorPusher.registerLink(link);
    },
    async transitionClarifying(autopilotReqId: string) {
      setRequirementStatus(autopilotReqId, "clarifying");
    },
    triggerSnapshot(autopilotReqId: string) {
      void mirrorPusher.pushSnapshot(autopilotReqId);
    },
  });
  _assignmentPoller = assignmentPoller;
  assignmentPoller.start();

  // ── commands poller ──────────────────────────────────────────
  const commandPoller = new CommandPoller({
    backend,
    pollWaitSeconds: 50,
    async addComment({ requirementId, kind, from_role, body, parent_id }) {
      const id = nextCommentId();
      createComment({
        id,
        requirement_id: requirementId,
        kind,
        from_role,
        body,
        parent_id: parent_id ?? null,
      });
      const req = getRequirementById(requirementId);
      if (kind === "feedback" && req?.status === "awaiting_review") {
        setRequirementStatus(requirementId, "fix_revision");
      }
    },
    resolveComment(commentId: string) {
      resolveComment(commentId);
    },
    async finishClarification({ id }) {
      coreFinishClarification(id);
    },
    async retryClarify({ id }) {
      await runClarifierRound(id);
    },
    async enqueue({ id }) {
      setRequirementStatus(id, "queued");
    },
    async cancel({ id }) {
      cancelRequirementWithTasks(id);
    },
    async setWorkspaces({ id, workspace_ids }) {
      setRequirementWorkspaces(id, workspace_ids);
    },
  });
  _commandPoller = commandPoller;
  commandPoller.start();

  // ── 心跳 ──────────────────────────────────────────────────
  const HEARTBEAT_MS = 30_000;
  _heartbeatTimer = setInterval(() => {
    backend.heartbeat().catch((e: unknown) => {
      log.warn("selfhosted 心跳失败：%s", e instanceof Error ? e.message : String(e));
    });
  }, HEARTBEAT_MS);

  log.info("selfhosted connector 已启动");

  // ── 卸载函数 ──────────────────────────────────────────────
  return () => {
    if (_heartbeatTimer) {
      clearInterval(_heartbeatTimer);
      _heartbeatTimer = null;
    }
    _assignmentPoller?.dispose();
    _assignmentPoller = null;
    _commandPoller?.dispose();
    _commandPoller = null;
    _mirrorPusher?.dispose();
    _mirrorPusher = null;

    if (_taskCreatedHandler) {
      offEvent("task:created", _taskCreatedHandler);
      _taskCreatedHandler = null;
    }
    if (_taskUpdatedHandler) {
      offEvent("task:updated", _taskUpdatedHandler);
      _taskUpdatedHandler = null;
    }

    backend.deregister().catch(() => {/* 下线 best-effort */});
    _backend = null;
    log.info("selfhosted connector 已停止");
  };
}
