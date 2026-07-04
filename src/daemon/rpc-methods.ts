/**
 * RPC method 注册集中处 — 把现有 db / core 业务函数挂到 method name 上，
 * 让 WS 和 HTTP 都能调用同一份逻辑。
 *
 * 当前阶段（PR1 骨架）只挂 5 个 PoC：daemon.status / tasks.list /
 * tasks.get / workflows.list / projects.list。验证协议跑得通，再批量迁移。
 *
 * 命名约定（仿 OpenClaw `sessions.subscribe` 风）：`<resource>.<verb>`。
 *
 * 入参 / 出参用 unknown，handler 自己负责类型校验（抛 RpcError("INVALID_PARAM", …)）。
 */

import {
  listTasks,
  listTasksByRequirement,
  getTask,
  getKv,
  getTaskLogs,
  listTaskPhaseEvents,
  getWorkflowPhaseStats,
} from "../core/db";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import {
  listWorkflows,
  getWorkflowTs as registryGetWorkflowTs,
  reload as reloadRegistry,
} from "../core/workflow/registry";
import { patchWorkflowMetaSpec, type WorkflowMetaInput } from "../core/workflow/registry-authoring";
import { updateDbWorkflow, deleteDbWorkflow, getWorkflowFromDb, listWorkflowsInDb, createDbWorkflow, createNativeDbWorkflow } from "../core/workflow/workflows";
import { parseWorkflowText, stringifyWorkflowDoc } from "../core/workflow/serialize";
import { listWorkflowTemplates } from "../core/workflow/templates";
import { runWorkflowAuthor, saveAuthoredWorkflow as saveAuthoredWf } from "./workflow-author";
import { loadDefaultsConfig, saveDefaultsConfig, saveConfigRaw, loadDaemonConfig, saveDaemonConfig, loadGitConfig, loadSchedulerConfig, saveSchedulerConfig, systemTimezone, isValidTimezone } from "../core/config";
import { requestRestart, requestShutdown } from "./index";
import { loadApiToken } from "../core/api-token";
import { listTaskRepos } from "../core/sandbox";
import { listSandboxDir, readSandboxFile } from "../core/sandbox/browse";
import { scanTaskSandboxes } from "../core/sandbox/retention";
import { setKv, getDb } from "../core/db";
import { discover as registryDiscover, getWorkflow as registryGetWorkflow, listWorkflowsUsingProvider, WORKFLOW_NAME_RE } from "../core/workflow/registry";
import { getWorkflowView, computeWorkflowGraph, WorkflowViewError } from "./workflow-views";
import { emit as emitBus } from "../core/event-bus";
import {
  listProjects,
  getProjectById,
  createProject as coreCreateProject,
  updateProject as coreUpdateProject,
  deleteProject as coreDeleteProject,
  nextProjectId,
  DEFAULT_PROJECT_ID,
} from "../core/projects";
import { listRequirementsByProject } from "../core/requirements";
import { listWorkspaces, getWorkspaceById, getWorkspaceByAlias, createWorkspace, updateWorkspace, deleteWorkspace, nextWorkspaceId, getTopWorkspaceForProject } from "../core/sandbox/workspaces";
import { listSubmodules, discoverSubmodules } from "../core/sandbox/submodules";
import { checkWorkspaceHealth, detectWorkspaceGit, probeRemote, parseGithubFromRemote } from "../core/sandbox/workspace-health";
import {
  listSessions as listChatSessions,
  deleteSession as deleteChatSession,
  readManifest as readSessionManifest,
  readMessages as readSessionMessages,
} from "../core/sessions";
import { readDaemonFileLog, getDaemonFileLogPath } from "../core/logger";
import {
  listNotifications,
  unreadCount as notificationUnreadCount,
  markRead as markNotificationsRead,
  markAllRead as markAllNotificationsRead,
  markReadByRelated as markNotificationsReadByRelated,
  dismissNotification,
} from "../core/notify/stream";
import { listUnhealthy } from "../core/provider-health";
import {
  listRequirements as coreListRequirements,
  getRequirementById,
  createRequirement as coreCreateRequirement,
  updateRequirement as coreUpdateRequirement,
  setRequirementStatus,  finishClarification,
  listRequirementStatusLogs,
  listRequirementWorkspaceIds,
  listRequirementWorkspaces,
  setRequirementWorkspaces as coreSetRequirementWorkspaces,
  type Requirement,
} from "../core/requirements";

/** 给需求响应附 workspace_ids（requirement_workspaces 集合；RPC 层 join，core 返回类型不动） */
function attachWorkspaceIds<T extends { id: string }>(reqs: T[]): Array<T & { workspace_ids: string[] }> {
  const map = listRequirementWorkspaceIds(reqs.map((r) => r.id));
  return reqs.map((r) => ({ ...r, workspace_ids: map.get(r.id) ?? [] }));
}
import { listSubPrs } from "../core/requirements/sub-prs";
import { listDeliveries, listDeliveryFiles, maxDeliveryRound } from "../core/requirements/deliveries";
import { validateWorkflowInput } from "./workflow-declarations";
import { listSpecRevisionsByRequirement } from "../core/requirements/spec-revisions";
import { getRound as getClarifierRound } from "./clarifier-progress";
import { runClarifierRound } from "./requirement-clarifier";
import { runClarifierExtract } from "./requirement-extract";
import {
  listComments,
  createComment,
  getCommentById,
  resolveComment,
  nextCommentId,
  type Comment,
} from "../core/requirements/comments";
import {
  loadProviders,
  loadConfigRaw,
  PROVIDER_NAMES,
  saveProvider,
  saveLifecycleAgent,
  type ProviderName,
} from "../core/config";
import { effectiveClarifyConfig } from "./clarifier-agent";
import { effectiveFixConfig } from "./fix-revision-runner";
import { hasUsableProvider, ensureDefaultProviderSet, listUsableProviders } from "../core/default-provider";

const NO_USABLE_PROVIDER_MSG =
  "尚无可用的 AI 供应商 —— 请在「设置 → 提供商」配置（CLI 登录或填 API key）后重试。autopilot 需要至少一个可用供应商才能执行任务。";
import {
  listApiKeys,
  setApiKey,
  deleteApiKey,
  envKeyNameForProvider,
  maskApiKey,
} from "../core/api-keys";
import { BUILTIN_COMPAT_PROVIDERS } from "../agents/providers/api/compat";
import { detectProviderCli, detectAllProviders, probeCli } from "../agents/cli-status";
import {
  listProviders as listProviderEntries,
  getProviderById,
  getProviderByName as getProviderEntryByName,
  createProvider,
  updateProvider,
  deleteProvider,
  setProviderCliStatus,
  type ProviderType,
} from "../core/providers";
import { listProviderModels } from "../agents/model-list";
import { createAgent } from "../agents/registry";
import { DEFAULT_AGENT } from "../core/agent-defaults";
import { runChecks } from "../core/doctor";
import {
  listPhaseLogs,
  readPhaseLog,
  listAgentCalls,
  getAgentCall,
} from "../core/task/logs";
import { phaseIndex, parseDecisionCounts, renderDecisionMd } from "./routes";
import { computeTaskOutcome } from "./task-outcome";
import {
  cancelTaskAction,
  restartTaskAction,
  answerTaskAction,
  decideTaskAction,
  releaseTaskSandboxAction,
  cancelRequirementWithTasks,
  cancelTasksForRequirements,
  TaskActionError,
} from "./task-actions";
import { startTaskFromTemplate, StartTaskError } from "../core/task/factory";
import { startTaskFromPrompt } from "./start-from-prompt";
import { cascadeDeleteTask, deleteRequirementWithTasks, DeleteTaskError } from "../core/task/delete";
import { registerRpcMethod, hasRpcMethod, RpcError } from "./rpc";
import { wsManager } from "./ws";
import { VERSION, GIT_SHA, STARTED_AT_ISO } from "../index";
import { getUpdateInfo } from "../core/update-check";
import { listExtensionsInfo, invokeExtension } from "./extensions/registry";

/** 业务错误 → RpcError 透传（保留 code）；其他错误让 invokeRpcMethod 包成 INTERNAL */
function rethrowAsRpc(e: unknown): never {
  if (e instanceof TaskActionError) throw new RpcError(e.code, e.message);
  if (e instanceof StartTaskError) throw new RpcError("START_FAILED", e.message);
  if (e instanceof DeleteTaskError) throw new RpcError("DELETE_FAILED", e.message);
  throw e;
}

/** 把 unknown params 视为对象，缺失时给 {} */
function asObj(params: unknown): Record<string, unknown> {
  if (params == null) return {};
  if (typeof params !== "object" || Array.isArray(params)) {
    throw new RpcError("INVALID_PARAM", "params 必须是对象");
  }
  return params as Record<string, unknown>;
}

/**
 * alias 唯一性约束为 per-project。新建项目时理论上不会冲突，
 * 此函数作防御层，确保"冲突对用户无感"在极端情形下也成立。
 */
function generateUniqueAlias(projectId: string, baseAlias: string): string {
  if (!getWorkspaceByAlias(projectId, baseAlias)) return baseAlias;
  for (let n = 2; n <= 99; n++) {
    const candidate = `${baseAlias}-${n}`;
    if (!getWorkspaceByAlias(projectId, candidate)) return candidate;
  }
  return `${baseAlias}-${Date.now() % 100000}`;
}

/** 在 daemon 启动早期调用一次。重复调用幂等（检查 daemon.status 是否已注册）。 */
// registerCoreRpcMethods 已拆成下列按域分组的子函数（架构师审查：原为单个 2500 行函数）。
// 各子函数只是 registerRpcMethod 调用的分组容器，共享模块作用域（零 import 变化）。
// 注：method 历史按「迁移批次」落位、非严格按命名空间聚集，故个别分组含相邻域的少量方法。
function registerCoreQueryRpc(): void {
  registerRpcMethod({
    method: "daemon.status",
    description: "返回 daemon version / git_sha / started_at / pid / uptime / 各状态任务数",
    handler: () => ({
      version: VERSION,
      git_sha: GIT_SHA,
      started_at_iso: STARTED_AT_ISO,
      pid: process.pid,
      uptime: Math.floor(process.uptime()),
      // taskCounts 由 daemon 启动时维护；此处直接现算一次（小数据量 OK）
      taskCounts: countTasksByStatus(),
      update: getUpdateInfo(),
    }),
  });

  registerRpcMethod({
    method: "extensions.list",
    description: "列出 daemon 扩展及其自报状态（enabled/running + 扩展 status() 的展示 KV）",
    handler: () => ({ extensions: listExtensionsInfo() }),
  });

  registerRpcMethod({
    method: "extensions.invoke",
    description: "调用扩展自报的动作（路由到 Extension.invoke；动作语义由扩展定义，如注册）",
    handler: async (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      if (typeof p.action !== "string" || !p.action) throw new RpcError("INVALID_PARAM", "需要 action");
      const actionParams =
        p.params && typeof p.params === "object" ? (p.params as Record<string, unknown>) : {};
      const result = await invokeExtension(p.id, p.action, actionParams);
      return { result: result ?? null };
    },
  });

  registerRpcMethod({
    method: "daemon.setHost",
    description: "写入 config.yaml.daemon.host；需配合 daemon.restart 才生效",
    handler: async (params) => {
      const p = asObj(params);
      if (typeof p.host !== "string" || !p.host.trim()) {
        throw new RpcError("INVALID_PARAM", "需要 host (string)");
      }
      const host = p.host.trim();
      // 校验白名单 + 本机网卡命中。
      // 之前只看 IPv4 字面量合法 → 用户/恶意调用方传不可达 IP（如 192.0.2.1）
      // 会让 Bun.serve EADDRNOTAVAIL，supervisor 进崩溃循环、UI 完全失联。
      // 现在限定：loopback / 暴露全部网卡 / 命中 detectLanIPv4 的某个本机网卡。
      const { detectLanIPv4 } = await import("./routes");
      const lanIps = detectLanIPv4();
      const isAllowedLiteral = host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0";
      const isBindableLanIp = lanIps.includes(host);
      if (!isAllowedLiteral && !isBindableLanIp) {
        throw new RpcError(
          "INVALID_PARAM",
          `host "${host}" 不可绑定。可选：localhost / 127.0.0.1 / 0.0.0.0 / ${lanIps.join(" / ") || "(无 LAN IP)"}`,
        );
      }
      // 切到暴露 host 且未设防 → 自动生成 token 配套（与 SEC-6 启动门同语义：
      // 不留「配置矛盾等重启引爆」的窗口）。返回一次性明文供调用方展示。
      let generatedToken: string | null = null;
      const { isExposedHost: isExposed, getApiTokenState: tokenState, reloadApiToken: reloadToken } =
        await import("./routes");
      const { hasAnyUser: anyUser } = await import("../core/auth");
      let hasUser = false;
      try { hasUser = anyUser(); } catch { /* users 表未建（极简测试库）→ 视为无用户 */ }
      if (isExposed(host) && !tokenState().is_set && !hasUser) {
        const { generateApiToken, saveApiToken } = await import("../core/api-token");
        generatedToken = generateApiToken();
        saveApiToken(generatedToken);
        reloadToken();
      }
      const cur = loadDaemonConfig();
      saveDaemonConfig({ ...cur, host });
      return { ok: true, host, restart_required: true, generated_token: generatedToken };
    },
  });

  registerRpcMethod({
    method: "daemon.restart",
    description: "请求 supervisor 重启 daemon（exit code 75 触发 respawn）；裸跑（无 supervisor）模式返回 ok:false 不重启",
    handler: () => {
      // ok=false 表示「没有 supervisor、无法重启」（不会自杀）；客户端据此提示手动 stop+start，
      // 不要盲目轮询等重连。
      const ok = requestRestart(150);
      return { ok, scheduled_in_ms: 150 };
    },
  });

  registerRpcMethod({
    method: "daemon.shutdown",
    description: "优雅停机（daemon 自己关 server/socket 后 exit 0，supervisor 一并退出）。CLI stop 优先走此路径，避免 Windows 硬杀产生 zombie LISTEN socket",
    handler: () => {
      const ok = requestShutdown(150);
      return { ok, scheduled_in_ms: 150 };
    },
  });

  registerRpcMethod({
    method: "daemon.revealToken",
    description: "返回明文 API token（已鉴权调用方使用：loopback 豁免或带正确 token 的远端）",
    handler: () => {
      // 调用方能进到 RPC 链路一定已经过 token 校验（loopback 自动豁免或带对 token）
      // 返回明文不增加新攻击面 —— 真正的安全边界是"拿到 token 才能进来"
      const token = loadApiToken();
      return { token: token ?? "", is_set: !!token };
    },
  });

  registerRpcMethod({
    method: "tasks.list",
    description: "列出所有任务，可选 status / workflow / limit 过滤",
    handler: (params) => {
      const p = asObj(params);
      const status = typeof p.status === "string" ? p.status : undefined;
      const workflow = typeof p.workflow === "string" ? p.workflow : undefined;
      const limit = typeof p.limit === "number" ? p.limit : undefined;
      return listTasks({ status, workflow, limit });
    },
  });

  registerRpcMethod({
    method: "tasks.get",
    description: "按 id 获取任务详情；不存在抛 NOT_FOUND",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) {
        throw new RpcError("INVALID_PARAM", "需要 id (string)");
      }
      const task = getTask(p.id);
      if (!task) throw new RpcError("NOT_FOUND", `task ${p.id} 不存在`);
      return task;
    },
  });

  registerRpcMethod({
    method: "tasks.listByRequirement",
    description: "按需求 id 列出其全部根 run（按 seq 升序），供需求页 run 历史切换",
    handler: (params) => {
      const p = asObj(params);
      const reqId = typeof p.requirementId === "string" && p.requirementId
        ? p.requirementId
        : (typeof p.requirement_id === "string" ? p.requirement_id : "");
      if (!reqId) {
        throw new RpcError("INVALID_PARAM", "需要 requirementId (string)");
      }
      return listTasksByRequirement(reqId);
    },
  });

  registerRpcMethod({
    method: "workflows.list",
    description: "列出已注册的工作流（含 source / derives_from）",
    handler: () => {
      const inMem = listWorkflows();
      const dbRows = listWorkflowsInDb();
      const sourceMap = new Map(dbRows.map((r) => [r.name, r]));
      return inMem.map((wf) => {
        const row = sourceMap.get(wf.name);
        return { ...wf, source: row?.source ?? "file", derives_from: row?.derives_from ?? null };
      });
    },
  });

  registerRpcMethod({
    method: "projects.list",
    description: "列出所有 Project",
    handler: () => listProjects(),
  });

  // ── 第二批 PoC（高频查询类） ──

  registerRpcMethod({
    method: "providers.list",
    description: "provider 条目列表（ProviderItem 兼容 shape：name/enabled/default_model/agent_count）",
    handler: () => {
      return listProviderEntries().map((p) => ({
        name: p.name,
        enabled: p.enabled !== 0,
        default_model: p.default_model ?? undefined,
        agent_count: 0, // 命名复用 agent 已移除；保留字段兼容旧 shape
      }));
    },
  });

  registerRpcMethod({
    method: "providers.statusAll",
    description: "三家 CLI 健康检查（并行 detect）",
    handler: async () => Object.values(await detectAllProviders()),
  });

  // agents.list 已移除（Phase 3：命名复用 agent 机制删除）。
  // Web Agents 页运行时会拿到 METHOD_NOT_FOUND，留待 Phase 4 处理客户端。

  // ── notifications（事件型通知流；旧 now.* 派生快照体系已于 2026-06-11 移除） ──

  registerRpcMethod({
    method: "notifications.list",
    description: "通知列表（id 倒序游标分页；默认不含已删除）",
    handler: (params) => {
      const p = asObj(params);
      return listNotifications({
        limit: typeof p.limit === "number" ? p.limit : undefined,
        before_id: typeof p.before_id === "number" ? p.before_id : undefined,
        unread_only: p.unread_only === true,
        include_dismissed: p.include_dismissed === true,
      });
    },
  });

  registerRpcMethod({
    method: "notifications.unreadCount",
    description: "未读通知数（排除已删除）",
    handler: () => ({ count: notificationUnreadCount() }),
  });

  registerRpcMethod({
    method: "notifications.markRead",
    description: "标记通知已读（幂等，只动仍未读的行）",
    handler: (params) => {
      const p = asObj(params);
      if (!Array.isArray(p.ids) || p.ids.length === 0 || !p.ids.every((x) => typeof x === "number")) {
        throw new RpcError("INVALID_PARAM", "需要非空 number[] ids");
      }
      const updated = markNotificationsRead(p.ids as number[]);
      emitBus({ type: "notification:read", payload: { ids: p.ids as number[] } });
      return { updated };
    },
  });

  registerRpcMethod({
    method: "notifications.markReadByRelated",
    description: "按关联实体批量已读（用户点进任务/需求详情页即视为消化了相关通知）",
    handler: (params) => {
      const p = asObj(params);
      if (p.related_type !== "task" && p.related_type !== "requirement" && p.related_type !== "system") {
        throw new RpcError("INVALID_PARAM", "related_type 需为 task / requirement / system");
      }
      if (typeof p.related_id !== "string" || !p.related_id) {
        throw new RpcError("INVALID_PARAM", "需要 related_id");
      }
      const ids = markNotificationsReadByRelated(p.related_type, p.related_id);
      if (ids.length > 0) emitBus({ type: "notification:read", payload: { ids } });
      return { updated: ids.length, ids };
    },
  });

  registerRpcMethod({
    method: "notifications.markAllRead",
    description: "全部标为已读（幂等）",
    handler: () => {
      const updated = markAllNotificationsRead();
      emitBus({ type: "notification:all_read", payload: {} });
      return { updated };
    },
  });

  registerRpcMethod({
    method: "notifications.dismiss",
    description: "删除（隐藏）一条通知；幂等",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "number") throw new RpcError("INVALID_PARAM", "需要 number id");
      const ok = dismissNotification(p.id);
      if (!ok) throw new RpcError("NOT_FOUND", `通知 ${p.id} 不存在`);
      emitBus({ type: "notification:dismissed", payload: { id: p.id } });
      return { ok: true };
    },
  });

  registerRpcMethod({
    method: "providers.health",
    description: "当前不健康的 provider 列表（轻量内存态，给通知面板 banner 初始拉取）",
    handler: () => listUnhealthy(),
  });

  registerRpcMethod({
    method: "providers.usableCount",
    description: "可用 provider 数 + 条目总数（给「无可用供应商」横幅）。可用 = cli 已登录 ok / api 有 key。",
    handler: async () => {
      const usable = await listUsableProviders();
      let total = 0;
      try { total = listProviderEntries().length; } catch { /* DB 未就绪 */ }
      return { usable: usable.length, total };
    },
  });

  registerRpcMethod({
    method: "setup.status",
    description: "Level-1 doctor 检查 + 用户是否 dismiss 过 setup 横幅",
    handler: async () => {
      const report = await runChecks({ level: 1 });
      let dismissed = false;
      try {
        dismissed = getKv("setup.dismissed") === "1";
      } catch {
        // kv 表未建（迁移未跑）时跳过
      }
      return { ...report, setupDismissed: dismissed };
    },
  });

  registerRpcMethod({
    method: "config.get",
    description: "返回 config.yaml 原文（用户配置）",
    handler: () => ({ yaml: loadConfigRaw() }),
  });

}

function registerTaskRpc(): void {
  // ── 第三批：tasks.* / workflows.* 查询类（10 个） ──

  registerRpcMethod({
    method: "tasks.logs",
    description: "任务的状态机日志（task_logs 表），可选 limit",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      const limit = typeof p.limit === "number" ? p.limit : 100;
      return getTaskLogs(p.id, limit);
    },
  });

  registerRpcMethod({
    method: "tasks.phaseLogs",
    description: "列出任务 sandbox 下已有的阶段日志文件元信息",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      try {
        return listPhaseLogs(p.id);
      } catch (e: unknown) {
        throw new RpcError("INVALID_PARAM", e instanceof Error ? e.message : String(e));
      }
    },
  });

  registerRpcMethod({
    method: "tasks.phaseLog",
    description: "读单个阶段日志原文，可选 tail 截尾",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      if (typeof p.phase !== "string" || !p.phase) throw new RpcError("INVALID_PARAM", "需要 phase");
      const tail = typeof p.tail === "number" ? p.tail : undefined;
      try {
        const content = readPhaseLog(p.id, p.phase, tail !== undefined ? { tail } : undefined);
        return { phase: p.phase, content };
      } catch (e: unknown) {
        throw new RpcError("INVALID_PARAM", e instanceof Error ? e.message : String(e));
      }
    },
  });

  registerRpcMethod({
    method: "tasks.phaseEvents",
    description: "任务的 phase 事件序列（task_phase_events 表）",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      // 与 HTTP /phase-events 一致：wrap 在 { events: [...] } 里
      return { events: listTaskPhaseEvents(p.id) };
    },
  });

  registerRpcMethod({
    method: "tasks.outcome",
    description: "终态任务的结果概览（diff_stat / pr_url / top_phases ...）",
    handler: async (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      const outcome = await computeTaskOutcome(p.id);
      if (!outcome) throw new RpcError("NOT_FOUND", "task 不在终态");
      return outcome;
    },
  });

  registerRpcMethod({
    method: "tasks.diffFiles",
    description: "任务工作树相对 base 分支的按文件 diff（验收视图）",
    handler: async (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      const task = getTask(p.id);
      if (!task) throw new RpcError("NOT_FOUND", "task not found");
      const { computeFileDiffs } = await import("./task-outcome");
      // 统一 multi-clone 布局：按 .worktree.json 的 repos 逐库取 diff（单库 = 长度 1；
      // 多库文件路径加 <dir>/ 前缀区分归属）。旧 mode=clone 任务 listTaskRepos 返回
      // 根路径单项（dir=""），行为与原 repo_path 直跑一致。
      const repos = listTaskRepos(p.id).filter((r) => existsSync(r.path));
      if (repos.length > 0) {
        const files = repos.flatMap((r) =>
          computeFileDiffs(r.path, r.base).map((f) => (r.dir ? { ...f, file: `${r.dir}/${f.file}` } : f)),
        );
        return { files };
      }
      // 无布局元数据（极旧任务）：回退 repo_path 直跑
      const repoPath = (task as Record<string, unknown>).repo_path as string | undefined;
      if (!repoPath || !existsSync(repoPath)) return { files: [] };
      const reqId = (task as Record<string, unknown>).requirement_id as string | undefined;
      let base = "main";
      if (reqId) {
        const req = getRequirementById(reqId);
        if (req?.workspace_id) {
          const ws = getWorkspaceById(req.workspace_id);
          if (ws?.default_branch) base = ws.default_branch;
        }
      }
      return { files: computeFileDiffs(repoPath, base) };
    },
  });

  registerRpcMethod({
    method: "tasks.agentCalls",
    description: "agent 调用 transcript 摘要列表",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      try {
        return listAgentCalls(p.id);
      } catch (e: unknown) {
        throw new RpcError("INVALID_PARAM", e instanceof Error ? e.message : String(e));
      }
    },
  });

  registerRpcMethod({
    method: "tasks.agentCall",
    description: "单次 agent 调用完整记录（按 seq）",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      if (typeof p.seq !== "number") throw new RpcError("INVALID_PARAM", "需要 seq (number)");
      const rec = getAgentCall(p.id, p.seq);
      if (!rec) throw new RpcError("NOT_FOUND", `agent call seq=${p.seq} 不存在`);
      return rec;
    },
  });

  // 注：tasks.events / tasks.subtasks RPC 已删（DC-2/DC-3）——零 web/tui/cli/client 消费方。
  // core readTaskEvents / db.getSubTasks 保留（HTTP 双胞胎 + task-delete 级联仍用）。

  registerRpcMethod({
    method: "workflows.phaseStats",
    description: "同工作流历史 phase 耗时 P50（给 TaskPhaseTimeline 参考线用）",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.workflow !== "string" || !p.workflow) throw new RpcError("INVALID_PARAM", "需要 workflow");
      // 与 HTTP /phase-stats 一致：wrap 在 { stats: {...} } 里
      return { stats: getWorkflowPhaseStats(p.workflow) };
    },
  });

  // ── 第四批：tasks.* mutation（5 个） ──

  registerRpcMethod({
    method: "tasks.start",
    description: "启动新任务：带 requirement_id/reqId 走模板路径；只给 prompt/title 无需求时自动抽需求再入队",
    handler: async (params) => {
      const p = asObj(params);
      const hasReqLink =
        (typeof p.requirement_id === "string" && p.requirement_id.trim()) ||
        (typeof p.reqId === "string" && p.reqId.trim());
      try {
        if (hasReqLink) {
          // 正规模板路径：调用方已带需求 link，字段透传给 setup_func
          return await startTaskFromTemplate(p as Parameters<typeof startTaskFromTemplate>[0]);
        }

        // 无需求 link：把 requirement/title 当一句话描述，先抽需求再起任务（保住一行起活手感）。
        const rawText =
          (typeof p.requirement === "string" && p.requirement.trim()) ||
          (typeof p.title === "string" && p.title.trim()) ||
          "";
        if (!rawText) throw new RpcError("INVALID_PARAM", "需要 title 或 requirement");

        // workspace_alias → workspace_id（startTaskFromPrompt 只认 workspace_id）；兼容旧 codebase_* 键
        let workspaceId =
          (typeof p.workspace_id === "string" && p.workspace_id.trim() ? p.workspace_id.trim() : undefined) ??
          (typeof p.codebase_id === "string" && p.codebase_id.trim() ? p.codebase_id.trim() : undefined);
        const aliasParam =
          (typeof p.workspace_alias === "string" && p.workspace_alias.trim() ? p.workspace_alias.trim() : undefined) ??
          (typeof p.codebase_alias === "string" && p.codebase_alias.trim() ? p.codebase_alias.trim() : undefined);
        if (!workspaceId && aliasParam) {
          const workspaces = await import("../core/sandbox/workspaces");
          const ws = workspaces.listWorkspaces({ includeSubmodules: true }).find((c) => c.alias === aliasParam);
          if (!ws) throw new RpcError("NOT_FOUND", `找不到别名为 "${aliasParam}" 的 workspace`);
          workspaceId = ws.id;
        }

        const workflow = typeof p.workflow === "string" && p.workflow.trim() ? p.workflow.trim() : undefined;
        const result = await startTaskFromPrompt({ rawText, workspace_id: workspaceId, workflow });
        // 返回 requirement；task 由 scheduler 异步起（必有工作区，无则上面已抛 NO_WORKSPACE）
        return result.requirement;
      } catch (e: unknown) {
        rethrowAsRpc(e);
      }
    },
  });

  registerRpcMethod({
    method: "tasks.sendPrompt",
    description: "运行中 task 追加 prompt（spec §3.8 三档分支：running→排队 / awaiting→answerPending / 终态拒绝）",
    handler: async (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      const prompt = typeof p.prompt === "string" ? p.prompt : "";
      if (!prompt.trim()) throw new RpcError("INVALID_PARAM", "需要 prompt");
      const { sendPromptToTask } = await import("../core/task/send-prompt");
      const result = sendPromptToTask(p.id, prompt, { source: "user" });
      if (!result.accepted) {
        if (result.reason === "TASK_TERMINAL") throw new RpcError("TASK_TERMINAL", "task 已是终态，无法接受新 prompt");
        if (result.reason === "NO_PROMPT_TARGET") throw new RpcError("NOT_FOUND", "task 不存在");
        throw new RpcError("INVALID_PARAM", result.reason ?? "rejected");
      }
      return { mode: result.mode, accepted: true };
    },
  });

  registerRpcMethod({
    method: "tasks.startAdHoc",
    description: "一句话发包 = 自动抽需求 + 入队执行（先建真需求进池，再让任务挂其下）",
    handler: async (params) => {
      const p = asObj(params);
      const prompt = typeof p.prompt === "string" ? p.prompt.trim() : "";
      if (!prompt) throw new RpcError("INVALID_PARAM", "需要 prompt");
      const workflow = typeof p.workflow === "string" && p.workflow.trim() ? p.workflow.trim() : "ad-hoc";

      // 可选 workspace 透传：让 sandbox.git=true 时能起 git worktree；兼容旧 codebase_* 键
      let workspaceId =
        (typeof p.workspace_id === "string" && p.workspace_id.trim() ? p.workspace_id.trim() : undefined) ??
        (typeof p.codebase_id === "string" && p.codebase_id.trim() ? p.codebase_id.trim() : undefined);
      const aliasParam =
        (typeof p.workspace_alias === "string" && p.workspace_alias.trim() ? p.workspace_alias.trim() : undefined) ??
        (typeof p.codebase_alias === "string" && p.codebase_alias.trim() ? p.codebase_alias.trim() : undefined);
      if (!workspaceId && aliasParam) {
        const workspaces = await import("../core/sandbox/workspaces");
        const ws = workspaces.listWorkspaces({ includeSubmodules: true }).find((c) => c.alias === aliasParam);
        if (!ws) throw new RpcError("NOT_FOUND", `找不到别名为 "${aliasParam}" 的 workspace`);
        workspaceId = ws.id;
      }

      try {
        const result = await startTaskFromPrompt({ rawText: prompt, workspace_id: workspaceId, workflow });
        // 返回 requirement；task 由 scheduler 异步起（必有工作区，无则上面已抛 NO_WORKSPACE）
        return result.requirement;
      } catch (e: unknown) {
        rethrowAsRpc(e);
      }
    },
  });

  registerRpcMethod({
    method: "tasks.cancel",
    description: "取消任务（非终态才允许）",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      try {
        return cancelTaskAction(p.id);
      } catch (e: unknown) {
        rethrowAsRpc(e);
      }
    },
  });

  registerRpcMethod({
    method: "tasks.restart",
    description: "从当前阶段重新执行（dangling 救援，绕过状态机）",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      try {
        return restartTaskAction(p.id);
      } catch (e: unknown) {
        rethrowAsRpc(e);
      }
    },
  });

  registerRpcMethod({
    method: "tasks.delete",
    description: "彻底删除任务（DB + 文件 + 锁；仅终态）",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      try {
        const res = cascadeDeleteTask(p.id);
        return { ok: true, deleted: res.deleted };
      } catch (e: unknown) {
        rethrowAsRpc(e);
      }
    },
  });

  registerRpcMethod({
    method: "tasks.answer",
    description: "用户回答 agent 的 ask_user 提问",
    handler: async (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      if (typeof p.text !== "string") throw new RpcError("INVALID_PARAM", "需要 text");
      try {
        return await answerTaskAction(p.id, p.text);
      } catch (e: unknown) {
        rethrowAsRpc(e);
      }
    },
  });

}

function registerWorkflowRpc(): void {
  // ── 第五批：workflows.* 域（11 个，含查询 + 简单 mutation） ──

  registerRpcMethod({
    method: "workflows.get",
    description: "工作流详情视图（剥 func 字段 + 加 source/derives_from）",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.name !== "string" || !p.name) throw new RpcError("INVALID_PARAM", "需要 name");
      try {
        return getWorkflowView(p.name);
      } catch (e: unknown) {
        if (e instanceof WorkflowViewError) throw new RpcError(e.code, e.message);
        throw e;
      }
    },
  });

  registerRpcMethod({
    method: "workflows.graph",
    description: "工作流状态机图数据（nodes + edges + initialState + terminalStates）",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.name !== "string" || !p.name) throw new RpcError("INVALID_PARAM", "需要 name");
      try {
        return computeWorkflowGraph(p.name);
      } catch (e: unknown) {
        if (e instanceof WorkflowViewError) throw new RpcError(e.code, e.message);
        throw e;
      }
    },
  });

  registerRpcMethod({
    method: "workflows.getSpec",
    description: "读取 workflow spec_json（P2 后：yaml_content 列已删除，spec_json 是唯一真相）",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.name !== "string" || !p.name) throw new RpcError("INVALID_PARAM", "需要 name");
      const row = getWorkflowFromDb(p.name);
      if (!row) throw new RpcError("NOT_FOUND", "Workflow not found");
      return { spec: row.spec_json ?? "{}" };
    },
  });

  // workflows.getYaml → 410（P2 废弃，改用 workflows.getSpec）
  registerRpcMethod({
    method: "workflows.getYaml",
    description: "已废弃（P2），请改用 workflows.getSpec",
    handler: () => {
      throw new RpcError("GONE", "workflows.getYaml 已废弃（P2），请改用 workflows.getSpec（返回 {spec: <JSON文本>}）");
    },
  });

  registerRpcMethod({
    method: "workflows.getTs",
    description: "读取 workflow.ts 源码（零代码工作流可能为 null）",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.name !== "string" || !p.name) throw new RpcError("INVALID_PARAM", "需要 name");
      const content = registryGetWorkflowTs(p.name);
      if (content === null) throw new RpcError("NOT_FOUND", "workflow.ts not found");
      return { content };
    },
  });

  registerRpcMethod({
    method: "workflows.templates",
    description: "列出可用的内置工作流模板",
    handler: () => ({ templates: listWorkflowTemplates() }),
  });

  // workflows.scanHealth 已于 P1 退役（file 轨孤儿扫描无意义），已从 rpc-methods 移除。

  registerRpcMethod({
    method: "workflows.import",
    description: "从 JSON 文本导入工作流落 DB（不写磁盘）：有 derives_from → 派生(derived) / 无 → 独立(native)",
    handler: async (params) => {
      const p = asObj(params);
      if (typeof p.name !== "string" || !p.name) throw new RpcError("INVALID_PARAM", "需要 name");
      if (!WORKFLOW_NAME_RE.test(p.name)) throw new RpcError("INVALID_PARAM", "name 只能用小写字母开头 + 小写字母/数字/_/-（≤40 字符）");
      if (typeof p.content !== "string") throw new RpcError("INVALID_PARAM", "需要 content");
      const description = typeof p.description === "string" ? p.description : "";
      const derivesFrom = typeof p.derives_from === "string" && p.derives_from.trim() ? p.derives_from.trim() : null;
      let doc: unknown;
      try {
        doc = parseWorkflowText(p.content, "json"); // 用户面统一 JSON
      } catch (e: unknown) {
        throw new RpcError("INVALID_PARAM", `JSON 解析失败：${e instanceof Error ? e.message : String(e)}`);
      }
      if (!doc || typeof doc !== "object" || !Array.isArray((doc as Record<string, unknown>)["phases"])) {
        throw new RpcError("INVALID_PARAM", "工作流缺 phases 字段");
      }
      try {
        const row = derivesFrom
          ? createDbWorkflow({ name: p.name, description, derives_from: derivesFrom, spec_json: stringifyWorkflowDoc(doc, "json") })
          : createNativeDbWorkflow({ name: p.name, description, spec_json: stringifyWorkflowDoc(doc, "json") });
        await reloadRegistry();
        return { name: row.name, kind: row.kind, source: row.source };
      } catch (e: unknown) {
        throw new RpcError("IMPORT_FAILED", e instanceof Error ? e.message : String(e));
      }
    },
  });

  registerRpcMethod({
    method: "workflows.export",
    description: "导出工作流为 JSON（结构原生 json，跟内部 spec_json 真相一致；P2 后所有 kind 均从 spec_json 读）",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.name !== "string" || !p.name) throw new RpcError("INVALID_PARAM", "需要 name");
      const row = getWorkflowFromDb(p.name);
      if (!row) throw new RpcError("NOT_FOUND", "Workflow not found");
      // P2 后：所有工作流真相在 spec_json（yaml_content 列已删除）
      if (!row.spec_json) throw new RpcError("NOT_FOUND", "Workflow spec not found");
      return { content: row.spec_json };
    },
  });

  registerRpcMethod({
    method: "workflows.author",
    description: "AI 生成声明式 workflow spec（JSON，零 ts，不落盘，返回预览）",
    handler: async (params) => {
      const p = asObj(params);
      if (typeof p.description !== "string" || !p.description.trim()) {
        throw new RpcError("INVALID_PARAM", "需要 description");
      }
      return await runWorkflowAuthor({
        description: p.description,
        prior_spec: typeof p.prior_spec === "string" ? p.prior_spec : undefined,
      });
    },
  });

  registerRpcMethod({
    method: "workflows.saveAuthored",
    description: "把 AI 生成的声明式 workflow spec 落 DB（native）+ reload + emit",
    handler: async (params) => {
      const p = asObj(params);
      if (typeof p.name !== "string" || !p.name || typeof p.spec_json !== "string") {
        throw new RpcError("INVALID_PARAM", "需要 name + spec_json");
      }
      try {
        saveAuthoredWf(p.name, p.spec_json);
        await reloadRegistry();
        emitBus({ type: "workflow:reloaded", payload: {} });
        return { ok: true, name: p.name };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        const code = msg.includes("已存在") || msg.includes("already exists") ? "ALREADY_EXISTS"
          : msg.includes("只允许") || msg.includes("name") ? "INVALID_NAME"
          : "SAVE_FAILED";
        throw new RpcError(code, msg);
      }
    },
  });

  registerRpcMethod({
    method: "workflows.saveSpec",
    description: "保存 workflow spec_json（P2 后：yaml_content 列已删除，直接写 spec_json）",
    handler: async (params) => {
      const p = asObj(params);
      if (typeof p.name !== "string" || !p.name) throw new RpcError("INVALID_PARAM", "需要 name");
      if (typeof p.spec !== "string") throw new RpcError("INVALID_PARAM", "需要 spec（JSON 文本）");
      const row = getWorkflowFromDb(p.name);
      try {
        if (!row) throw new RpcError("NOT_FOUND", "Workflow not found");
        // 校验 JSON 可解析
        JSON.parse(p.spec);
        updateDbWorkflow(p.name, { spec_json: p.spec });
        await reloadRegistry();
        emitBus({ type: "workflow:reloaded", payload: {} });
        return { ok: true };
      } catch (e: unknown) {
        throw new RpcError("SAVE_FAILED", e instanceof Error ? e.message : String(e));
      }
    },
  });

  // workflows.saveYaml → 410（P2 废弃，改用 workflows.saveSpec）
  registerRpcMethod({
    method: "workflows.saveYaml",
    description: "已废弃（P2），请改用 workflows.saveSpec",
    handler: () => {
      throw new RpcError("GONE", "workflows.saveYaml 已废弃（P2），请改用 workflows.saveSpec（传 {name, spec: <JSON文本>}）");
    },
  });

  registerRpcMethod({
    method: "workflows.setMeta",
    description: "修改工作流显示名 / 描述 + 声明层（requiresGit / sandboxGit）；产出形态 delivers 从 phase 自动派生不接受输入；name 是标识符与引用键，不可改",
    handler: async (params) => {
      const p = asObj(params);
      if (typeof p.name !== "string" || !p.name) throw new RpcError("INVALID_PARAM", "需要 name");
      const meta: WorkflowMetaInput = {};
      if ("label" in p) {
        if (p.label !== null && typeof p.label !== "string") {
          throw new RpcError("INVALID_PARAM", "label 需为字符串或 null");
        }
        meta.label = p.label as string | null;
      }
      if ("description" in p) {
        if (p.description !== null && typeof p.description !== "string") {
          throw new RpcError("INVALID_PARAM", "description 需为字符串或 null");
        }
        meta.description = p.description as string | null;
      }
      // 声明层（v2 R5）：requiresGit / sandboxGit / delivers
      if ("requiresGit" in p) {
        const v = p.requiresGit;
        if (v !== null && v !== true && v !== false) {
          throw new RpcError("INVALID_PARAM", "requiresGit 需为 true / false / null（optional 已废弃）");
        }
        meta.requiresGit = v as boolean | null;
      }
      // 注：sandbox.git（建 git 沙盒）从 requires.git 派生、delivers 从 phase 派生，均不再由 setMeta 输入。
      if (
        meta.label === undefined && meta.description === undefined &&
        meta.requiresGit === undefined
      ) {
        throw new RpcError("INVALID_PARAM", "至少提供 label / description / requiresGit 之一");
      }
      if (!registryGetWorkflow(p.name)) throw new RpcError("NOT_FOUND", "Workflow not found");
      const row = getWorkflowFromDb(p.name);
      try {
        // file 轨已退役：所有工作流都在 DB
        if (!row) throw new RpcError("NOT_FOUND", "Workflow not found");
        // P2 后：操作 spec_json（patchWorkflowMetaSpec 纯 JSON 操作，yaml_content 已删除）
        const newSpec = patchWorkflowMetaSpec(row.spec_json ?? "{}", meta);
        updateDbWorkflow(p.name, { spec_json: newSpec });
        await reloadRegistry();
        emitBus({ type: "workflow:reloaded", payload: {} });
        return { ok: true };
      } catch (e: unknown) {
        throw new RpcError("SAVE_FAILED", e instanceof Error ? e.message : String(e));
      }
    },
  });

  registerRpcMethod({
    method: "workflows.delete",
    description: "删除工作流（区分 source）",
    handler: async (params) => {
      const p = asObj(params);
      if (typeof p.name !== "string" || !p.name) throw new RpcError("INVALID_PARAM", "需要 name");
      const row = getWorkflowFromDb(p.name);
      try {
        // file 轨已退役：所有工作流都在 DB
        if (!row) throw new RpcError("NOT_FOUND", "Workflow not found");
        deleteDbWorkflow(p.name);
        await reloadRegistry();
        emitBus({ type: "workflow:reloaded", payload: {} });
        return { ok: true };
      } catch (e: unknown) {
        if (e instanceof RpcError) throw e;
        throw new RpcError("DELETE_FAILED", e instanceof Error ? e.message : String(e));
      }
    },
  });

}

function registerRequirementRpc(): void {
  // ── 第六批：requirements.* 域（16 个） ──

  registerRpcMethod({
    method: "requirements.list",
    description: "列出需求，可选 workspace_id / project_id / status 过滤",
    handler: (params) => {
      const p = asObj(params);
      const workspace_id =
        (typeof p.workspace_id === "string" ? p.workspace_id : undefined) ??
        (typeof p.codebase_id === "string" ? p.codebase_id : undefined);
      const project_id = typeof p.project_id === "string" ? p.project_id : undefined;
      const status = typeof p.status === "string" ? p.status : undefined;
      return {
        requirements: attachWorkspaceIds(coreListRequirements({ workspace_id, project_id, status })),
      };
    },
  });

  registerRpcMethod({
    method: "requirements.get",
    description: "需求详情 + 评论历史（统一 question / feedback / handoff）",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      const r = getRequirementById(p.id);
      if (!r) throw new RpcError("NOT_FOUND", "requirement not found");
      return {
        requirement: attachWorkspaceIds([r])[0],
        comments: listComments(p.id),
      };
    },
  });

  registerRpcMethod({
    method: "requirements.setWorkspaces",
    description: "澄清前确认需求的代码库集合（整体替换；显式空集 = 确认无库 input_mode='none'；开始澄清后冻结——澄清基于已选库做，临时换库会让澄清失效。failed 例外 = 重试设计用途）",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      // 空数组合法（v2 R5：显式空集 = 确认无库，配合 requires.git 非 true 的工作流走纯文本闭环）
      if (
        !Array.isArray(p.workspace_ids) ||
        !p.workspace_ids.every((x) => typeof x === "string" && x)
      ) {
        throw new RpcError("INVALID_PARAM", "需要 string[] workspace_ids（空数组 = 确认无库）");
      }
      const wsIds = [...new Set(p.workspace_ids as string[])];
      // primary_workspace_id 入参接受但忽略（主库概念已废除，2026-06-12；兼容老 web-dist 一版）
      const cur = getRequirementById(p.id);
      if (!cur) throw new RpcError("NOT_FOUND", "requirement not found");
      // 开始澄清即冻结：澄清 agent 基于已选代码库的浅 clone 调查提问，
      // 中途换库会让已完成的澄清失效（failed 例外 = 重试设计用途，用户自担）
      const EDITABLE_STATUSES = new Set(["drafting", "failed"]);
      if (!EDITABLE_STATUSES.has(cur.status)) {
        throw new RpcError(
          "INVALID_STATE",
          `代码库集合在开始澄清后冻结（当前状态 ${cur.status}）——澄清基于已选代码库进行，中途更换会使澄清结论失效。`,
        );
      }
      for (const wid of wsIds) {
        const ws = getWorkspaceById(wid);
        if (!ws) throw new RpcError("NOT_FOUND", `workspace 不存在：${wid}`);
        if (ws.project_id !== cur.project_id) {
          throw new RpcError("PRECONDITION_FAILED", `代码库 ${ws.alias}（${wid}）不属于该需求的项目`);
        }
      }
      coreSetRequirementWorkspaces(p.id, wsIds);
      const updated = getRequirementById(p.id)!;
      return { requirement: attachWorkspaceIds([updated])[0], workspace_ids: wsIds };
    },
  });

  registerRpcMethod({
    method: "requirements.extract",
    description: "口语化需求 → AI 整理为 title + spec_md（LLM 长任务）",
    handler: async (params) => {
      const p = asObj(params);
      if (typeof p.raw_text !== "string" || !p.raw_text.trim()) {
        throw new RpcError("INVALID_PARAM", "需要 raw_text");
      }
      if (typeof p.project_id !== "string" || !p.project_id.trim()) {
        throw new RpcError("INVALID_PARAM", "需要 project_id");
      }
      const proj = getProjectById(p.project_id);
      if (!proj) throw new RpcError("NOT_FOUND", "project not found");
      const workspaceParam = (p.workspace_id ?? p.codebase_id) as string | null | undefined;
      if (workspaceParam) {
        const ws = getWorkspaceById(workspaceParam);
        if (!ws) throw new RpcError("NOT_FOUND", "workspace not found");
        if (ws.project_id !== p.project_id) {
          throw new RpcError("INVALID_PARAM", "workspace does not belong to project");
        }
      }
      return await runClarifierExtract({
        raw_text: p.raw_text,
        project_id: p.project_id,
        workspace_id: workspaceParam ?? null,
      });
    },
  });

  registerRpcMethod({
    method: "requirements.create",
    description: "创建需求（自动进入 clarifying 触发澄清流程）",
    handler: (params) => {
      const p = asObj(params);
      const rawWorkspace = p.workspace_id ?? p.codebase_id;
      let workspaceId = (typeof rawWorkspace === "string" || rawWorkspace === null)
        ? (rawWorkspace ?? null)
        : null;
      const title = typeof p.title === "string" ? p.title.trim() : "";
      if (!title) throw new RpcError("INVALID_PARAM", "title 必填");
      let projectId = typeof p.project_id === "string" ? p.project_id.trim() : "";
      if (workspaceId) {
        const ws = getWorkspaceById(workspaceId);
        if (!ws) throw new RpcError("NOT_FOUND", "workspace not found");
        if (!projectId) projectId = ws.project_id;
      }
      if (!projectId) {
        throw new RpcError("INVALID_PARAM", "project_id 必填（或提供 workspace_id 由 daemon 反查）");
      }
      // v2 R5：项目无工作区不再拒建需求（无库需求可走 requires.git 非 true 的工作流闭环）；
      // 未显式指定时自动派生项目默认工作区作预选（无则 workspace_id=NULL，由确认卡 / 闸门把关）。
      if (!workspaceId) workspaceId = getTopWorkspaceForProject(projectId)?.id ?? null;
      const created = coreCreateRequirement({
        project_id: projectId,
        workspace_id: workspaceId,
        title,
        spec_md: typeof p.spec_md === "string" ? p.spec_md : "",
        chat_session_id: (p.chat_session_id as string | null | undefined) ?? null,
        source: typeof p.source === "string" ? p.source : null,
        external_ref: typeof p.external_ref === "string" ? p.external_ref : null,
        callback_url: typeof p.callback_url === "string" ? p.callback_url : null,
        callback_secret: typeof p.callback_secret === "string" ? p.callback_secret : null,
      });
      // 停在 drafting：澄清依赖代码库 clone，须由用户确认代码库后显式进入澄清
      // （自动派生的默认库只是预选；Web 在需求页确认、CLI 用 req clarify / -c 显式指定时自动开始）
      return { requirement: created };
    },
  });

  registerRpcMethod({
    method: "requirements.update",
    description: "更新需求字段（title / spec_md / workspace_id / clarifier_*）",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      // 审批后内容冻结：审批 = 用户对这份 spec 签字，之后改 title/spec/workspace 会让
      // 「页面上的需求 ≠ agent 实际执行的快照」（req-008 串味事故的根源之一）。
      // failed 例外 —— 补充约束后重试正是 failed 的设计用途（评审遗留沉淀 + 改 spec + 重新入队）。
      const wantsContentEdit =
        typeof p.title === "string" || typeof p.spec_md === "string"
        || p.workspace_id !== undefined || p.codebase_id !== undefined
        || p.workflow !== undefined;
      if (wantsContentEdit) {
        const cur = getRequirementById(p.id);
        if (!cur) throw new RpcError("NOT_FOUND", "requirement not found");
        const EDITABLE_STATUSES = new Set(["drafting", "clarifying", "ready", "awaiting_approval", "failed"]);
        if (!EDITABLE_STATUSES.has(cur.status)) {
          throw new RpcError(
            "INVALID_STATE",
            `需求已通过审批（当前状态 ${cur.status}），标题/规约/工作区/工作流不可再编辑。` +
            `执行内容以入队时的快照为准；如需变更请取消后新建需求，或等失败（failed）后修改再重试。`,
          );
        }
      }
      // workflow 合法性：必须是已注册工作流（null = 清除显式选择，回退默认 dev）
      if (typeof p.workflow === "string" && p.workflow && !registryGetWorkflow(p.workflow)) {
        throw new RpcError("NOT_FOUND", `workflow 不存在：${p.workflow}`);
      }
      const updated = coreUpdateRequirement(p.id, {
        title: typeof p.title === "string" ? p.title : undefined,
        spec_md: typeof p.spec_md === "string" ? p.spec_md : undefined,
        workspace_id: ((p.workspace_id ?? p.codebase_id) as string | null | undefined),
        chat_session_id: (p.chat_session_id as string | null | undefined),
        clarifier_provider: (p.clarifier_provider as string | null | undefined),
        clarifier_model: (p.clarifier_model as string | null | undefined),
        workflow: (typeof p.workflow === "string" || p.workflow === null) ? p.workflow : undefined,
      });
      if (!updated) throw new RpcError("NOT_FOUND", "requirement not found");
      // setWorkflow 闸门（v2 R5）：换工作流时声明校验不通过 → 响应带 warning（不阻断，enqueue 兜底重验）
      if (p.workflow !== undefined) {
        const hasWs = listRequirementWorkspaces(p.id).length > 0 || !!updated.workspace_id;
        const warning = validateWorkflowInput(updated.workflow, hasWs, { crossCheckDelivers: true });
        if (warning) return { requirement: updated, warning: `${warning}（入队时将被拦截）` };
      }
      return { requirement: updated };
    },
  });

  registerRpcMethod({
    method: "requirements.delete",
    description: "删除一件工作（需求 + 其名下全部任务，含运行中）",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      if (!getRequirementById(p.id)) throw new RpcError("NOT_FOUND", "requirement not found");
      // 删前先停运行中任务的 agent 进程（best-effort）：让 runner 收敛、释放 sandbox 占用，
      // 再由 deleteRequirementWithTasks 强删记录。cancel 同步触发 abort（向子进程发 SIGTERM），
      // 但不阻塞等子进程实际退出 / phase 收敛，故不 sleep。
      cancelTasksForRequirements([p.id]);
      const { deletedTasks } = deleteRequirementWithTasks(p.id);
      // 连带删掉的任务逐个 emit task:deleted（由 purgeTaskTree 内部负责）；需求删除本身
      // 沿用旧行为不额外 emit（无 requirement:deleted 事件类型，避免伪造状态触发 scheduler/clarifier）。
      return { ok: true, deletedTasks: deletedTasks.length };
    },
  });

  registerRpcMethod({
    method: "requirements.transition",
    description: "手动转移需求状态（仍走状态机校验，非法转换会被拒）",
    handler: async (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      if (typeof p.to !== "string" || !p.to.trim()) throw new RpcError("INVALID_PARAM", "to 必填");
      const cur = getRequirementById(p.id);
      if (!cur) throw new RpcError("NOT_FOUND", "requirement not found");
      // 澄清前置（v2 R5 起按所选工作流的 requires.git 动态校验）：
      //   requires.git=true → 卡集合非空（澄清 agent 在已选代码库的浅 clone 中工作；真相在集合表）
      //   "optional"/false  → 集合空也放行（确认 input_mode='none'，clarifier 走纯文本模式）
      if (p.to.trim() === "clarifying") {
        // 澄清要起 clarifier agent —— 无可用 provider 提前拒，停下报人不撞墙
        if (!(await hasUsableProvider())) throw new RpcError("NO_USABLE_PROVIDER", NO_USABLE_PROVIDER_MSG);
        const hasWs = listRequirementWorkspaces(p.id).length > 0;
        const reason = validateWorkflowInput(cur.workflow, hasWs);
        if (reason) throw new RpcError("PRECONDITION_FAILED", `${reason}（澄清基于代码库的克隆进行）`);
        if (!hasWs && cur.input_mode !== "none") {
          try { coreUpdateRequirement(p.id, { input_mode: "none" }); } catch { /* 列缺失旧库容错 */ }
        }
      }
      return { requirement: setRequirementStatus(p.id, p.to.trim()) };
    },
  });

  registerRpcMethod({
    method: "requirements.enqueue",
    description: "入队执行（spec_md 非空；代码库要求按所选工作流的 requires.git 动态校验，集合空 × delivers:pr 交叉拒）",
    handler: async (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      const r = getRequirementById(p.id);
      if (!r) throw new RpcError("NOT_FOUND", "requirement not found");
      // 入队后调度器会起执行 run（agent）—— 无可用 provider 提前拒，停下报人不撞墙
      if (!(await hasUsableProvider())) throw new RpcError("NO_USABLE_PROVIDER", NO_USABLE_PROVIDER_MSG);
      // v2 R5：按所选工作流动态校验（requires.git=true 卡集合非空；optional/false 放行；
      // 交叉校验 = 集合空 × delivers:pr 拒——PR 无处可开）
      const hasWs = listRequirementWorkspaces(p.id).length > 0 || !!r.workspace_id;
      const reason = validateWorkflowInput(r.workflow, hasWs, { crossCheckDelivers: true });
      if (reason) throw new RpcError("PRECONDITION_FAILED", reason);
      if (!(r.spec_md ?? "").trim()) {
        throw new RpcError("PRECONDITION_FAILED", "需求规约为空，请先完成澄清或手动填写规约");
      }
      if (!hasWs && r.input_mode !== "none") {
        try { coreUpdateRequirement(p.id, { input_mode: "none" }); } catch { /* 列缺失旧库容错 */ }
      }
      return { requirement: setRequirementStatus(p.id, "queued") };
    },
  });


  registerRpcMethod({
    method: "requirements.cancel",
    description: "取消需求（级联停名下运行中任务）",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      if (!getRequirementById(p.id)) throw new RpcError("NOT_FOUND", "requirement not found");
      return cancelRequirementWithTasks(p.id, typeof p.reason === "string" ? p.reason : undefined);
    },
  });

  registerRpcMethod({
    method: "requirements.statusLogs",
    description: "需求状态转移历史（审批/排队时间点等，升序）",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      if (!getRequirementById(p.id)) throw new RpcError("NOT_FOUND", "requirement not found");
      return { logs: listRequirementStatusLogs(p.id) };
    },
  });

  registerRpcMethod({
    method: "requirements.subPrs",
    description: "需求关联的子模块 PR 列表",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      if (!getRequirementById(p.id)) throw new RpcError("NOT_FOUND", "requirement not found");
      return { sub_prs: listSubPrs(p.id) };
    },
  });

  registerRpcMethod({
    method: "requirements.deliveries",
    description: "需求的交付物轮次记录（artifacts 验收用；每验收轮一行，round 升序）",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      if (!getRequirementById(p.id)) throw new RpcError("NOT_FOUND", "requirement not found");
      return { deliveries: listDeliveries(p.id) };
    },
  });

  registerRpcMethod({
    method: "requirements.listDeliveryFiles",
    description: "某验收轮的交付物文件列表（缺省最新轮；只列文件 + 下载，不做渲染预览）",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      if (!getRequirementById(p.id)) throw new RpcError("NOT_FOUND", "requirement not found");
      const round = typeof p.round === "number" && Number.isInteger(p.round) && p.round >= 1
        ? p.round
        : maxDeliveryRound(p.id);
      if (round < 1) return { round: 0, files: [] };
      return { round, files: listDeliveryFiles(p.id, round) };
    },
  });

  registerRpcMethod({
    method: "requirements.specRevisions",
    description: "需求 spec_md 修改历史",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      if (!getRequirementById(p.id)) throw new RpcError("NOT_FOUND", "requirement not found");
      return { revisions: listSpecRevisionsByRequirement(p.id) };
    },
  });

  registerRpcMethod({
    method: "requirements.clarifierRound",
    description: "需求当前 clarifier 轮次的进度状态（无活动轮 → null）",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      if (!getRequirementById(p.id)) throw new RpcError("NOT_FOUND", "requirement not found");
      return { round: getClarifierRound(p.id) ?? null };
    },
  });

  // requirements.fixRound 已移除（v2 R3）：fix = 标准 run，修复进度即 task 进度
  //（requirement.task_id 指向 fix run，执行视图 / task logs / agent-calls 直接可看）。

  registerRpcMethod({
    method: "requirements.retryClarify",
    description: "重跑 clarifier 一轮（生成新问题）",
    handler: async (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      if (!getRequirementById(p.id)) throw new RpcError("NOT_FOUND", "requirement not found");
      await runClarifierRound(p.id);
      return { ok: true };
    },
  });

  registerRpcMethod({
    method: "requirements.finishClarification",
    description: "强制结束澄清进入 ready",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      if (!getRequirementById(p.id)) throw new RpcError("NOT_FOUND", "requirement not found");
      finishClarification(p.id);
      const updated = getRequirementById(p.id);
      return { requirement: updated };
    },
  });

  // ── 评论线程（统一 question / feedback / handoff） ──

  registerRpcMethod({
    method: "comments.list",
    description: "需求关联的评论列表（可按 kind / status 过滤）",
    handler: (params) => {
      const p = asObj(params);
      const reqId = typeof p.requirementId === "string" ? p.requirementId : (typeof p.id === "string" ? p.id : "");
      if (!reqId) throw new RpcError("INVALID_PARAM", "需要 requirementId");
      if (!getRequirementById(reqId)) throw new RpcError("NOT_FOUND", "requirement not found");
      const filter: { kind?: Comment["kind"]; status?: Comment["status"] } = {};
      if (p.kind === "question" || p.kind === "feedback" || p.kind === "handoff") filter.kind = p.kind;
      if (p.status === "open" || p.status === "resolved") filter.status = p.status;
      return { comments: listComments(reqId, filter) };
    },
  });

  registerRpcMethod({
    method: "comments.add",
    description: "追加一条评论（question/feedback/handoff）。feedback 在 awaiting_review 自动进 fix_revision",
    handler: (params) => {
      const p = asObj(params);
      const reqId = typeof p.requirementId === "string" ? p.requirementId : (typeof p.id === "string" ? p.id : "");
      if (!reqId) throw new RpcError("INVALID_PARAM", "需要 requirementId");
      if (p.kind !== "question" && p.kind !== "feedback" && p.kind !== "handoff") {
        throw new RpcError("INVALID_PARAM", "kind 必须是 question / feedback / handoff");
      }
      if (p.from_role !== "agent" && p.from_role !== "user" && p.from_role !== "github") {
        throw new RpcError("INVALID_PARAM", "from_role 必须是 agent / user / github");
      }
      const bodyText = typeof p.body === "string" ? p.body.trim() : "";
      if (!bodyText) throw new RpcError("INVALID_PARAM", "body 必填");
      const r = getRequirementById(reqId);
      if (!r) throw new RpcError("NOT_FOUND", "requirement not found");
      if (p.parent_id !== undefined && p.parent_id !== null && typeof p.parent_id !== "string") {
        throw new RpcError("INVALID_PARAM", "parent_id 必须是字符串或 null");
      }
      if (p.parent_id) {
        if (!getCommentById(p.parent_id as string)) throw new RpcError("NOT_FOUND", "parent comment not found");
      }
      const suggestions = Array.isArray(p.suggestions)
        ? p.suggestions.filter((s): s is string => typeof s === "string")
        : undefined;
      const id = nextCommentId();
      const comment = createComment({
        id,
        requirement_id: reqId,
        kind: p.kind as Comment["kind"],
        from_role: p.from_role as Comment["from_role"],
        body: bodyText,
        parent_id: (p.parent_id as string | undefined) ?? null,
        suggestions,
        github_review_id: typeof p.github_review_id === "string" ? p.github_review_id : null,
      });
      // feedback 注入：awaiting_review → fix_revision（沿用旧 inject_feedback 语义）；
      // awaiting_approval → clarifying（审批驳回 spec：回澄清重做，clarifier 经 status-changed 自动续轮）
      if (comment.kind === "feedback" && r.status === "awaiting_review") {
        try { setRequirementStatus(reqId, "fix_revision"); } catch { /* tolerated */ }
      } else if (comment.kind === "feedback" && r.status === "awaiting_approval") {
        try { setRequirementStatus(reqId, "clarifying"); } catch { /* tolerated */ }
      }
      return { comment };
    },
  });

  registerRpcMethod({
    method: "comments.resolve",
    description: "标记评论已解决；question 全部 resolved 时 emit requirement:all-questions-resolved",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      const c = getCommentById(p.id);
      if (!c) throw new RpcError("NOT_FOUND", "comment not found");
      resolveComment(p.id);
      if (c.kind === "question") {
        const allQuestions = listComments(c.requirement_id, { kind: "question" });
        if (allQuestions.length > 0 && allQuestions.every((q) => q.status === "resolved")) {
          emitBus({ type: "requirement:all-questions-resolved", payload: { id: c.requirement_id } });
        }
      }
      return { ok: true };
    },
  });

}

function registerProviderAgentRpc(): void {
  // ── 第七批：providers + agents CRUD（8 个） ──

  registerRpcMethod({
    method: "providers.status",
    description: "单独检测某家 CLI 健康状态",
    handler: async (params) => {
      const p = asObj(params);
      if (typeof p.name !== "string" || !p.name) throw new RpcError("INVALID_PARAM", "需要 name");
      if (!(PROVIDER_NAMES as readonly string[]).includes(p.name)) {
        throw new RpcError("INVALID_PARAM", `未知 provider：${p.name}`);
      }
      return await detectProviderCli(p.name as ProviderName);
    },
  });

  registerRpcMethod({
    method: "providers.models",
    description: "列某家的可用模型列表（API 或 catalog）",
    handler: async (params) => {
      const p = asObj(params);
      if (typeof p.name !== "string" || !p.name) throw new RpcError("INVALID_PARAM", "需要 name");
      if (!(PROVIDER_NAMES as readonly string[]).includes(p.name)) {
        throw new RpcError("INVALID_PARAM", `未知 provider：${p.name}`);
      }
      return await listProviderModels(p.name as ProviderName);
    },
  });

  registerRpcMethod({
    method: "providers.save",
    description: "保存 provider 条目配置（enabled / default_model / base_url，按 name 找条目 update）+ emit config:updated",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.name !== "string" || !p.name) throw new RpcError("INVALID_PARAM", "需要 name");
      const entry = getProviderEntryByName(p.name);
      if (!entry) throw new RpcError("NOT_FOUND", `provider 条目不存在：${p.name}`);
      try {
        updateProvider(entry.id, {
          enabled: typeof p.enabled === "boolean" ? p.enabled : undefined,
          default_model: typeof p.default_model === "string" ? p.default_model : undefined,
          base_url: typeof p.base_url === "string" ? p.base_url : undefined,
        });
        emitBus({ type: "config:updated", payload: {} });
        return { ok: true };
      } catch (e: unknown) {
        throw new RpcError("SAVE_FAILED", e instanceof Error ? e.message : String(e));
      }
    },
  });

  registerRpcMethod({
    method: "providers.setDefaultModel",
    description: "字段级设置某 provider 条目的默认模型（按 name 找条目 update）",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.name !== "string" || !p.name) throw new RpcError("INVALID_PARAM", "需要 name");
      const entry = getProviderEntryByName(p.name);
      if (!entry) throw new RpcError("NOT_FOUND", `provider 条目不存在：${p.name}`);
      const model = typeof p.model === "string" && p.model.trim() ? p.model.trim() : null;
      try {
        updateProvider(entry.id, { default_model: model });
        emitBus({ type: "config:updated", payload: {} });
        return { ok: true };
      } catch (e: unknown) {
        throw new RpcError("SAVE_FAILED", e instanceof Error ? e.message : String(e));
      }
    },
  });

  // ── 生命周期 agent 配置（lifecycle: 段；P1 仅 clarify，extract/author 共用其配置）──

  registerRpcMethod({
    method: "lifecycle.list",
    description: "生命周期 agent 配置列表（P1：clarify；effective=生效配置 + userConfig=用户显式写的 + defaults=代码兜底）",
    handler: () => {
      const c = effectiveClarifyConfig();
      const hasUser = Object.keys(c.userConfig).length > 0;
      const f = effectiveFixConfig();
      const fHasUser = Object.keys(f.userConfig).length > 0;
      return {
        agents: [
          {
            name: "clarify",
            display_name: "需求澄清",
            note: "澄清、一句话建需求、AI 生成工作流都用这套设置",
            effective: c.effective,
            userConfig: hasUser ? c.userConfig : null,
            defaults: c.defaults,
            reqOverridable: true,
          },
          {
            name: "fix",
            display_name: "修复轮",
            note: "驳回 / CI 失败后的修复回路（__fix）的 agent —— 含修复取向人设，可覆盖",
            effective: f.effective,
            userConfig: fHasUser ? f.userConfig : null,
            defaults: f.defaults,
            reqOverridable: false,
          },
        ],
      };
    },
  });

  registerRpcMethod({
    method: "lifecycle.setAgent",
    description: "写/删某生命周期 agent 配置（config=null 删段回退默认）。支持 name=clarify | fix",
    handler: (params) => {
      const p = asObj(params);
      if (p.name !== "clarify" && p.name !== "fix") throw new RpcError("INVALID_PARAM", "仅支持 name=clarify | fix");
      let cfg: Record<string, unknown> | null = null;
      if (p.config !== null && p.config !== undefined) {
        const c = asObj(p.config);
        // 只取已知字段（InlineAgentConfig 形状），空值视为不设
        cfg = {};
        if (typeof c.provider === "string" && c.provider) cfg.provider = c.provider;
        if (typeof c.model === "string" && c.model) cfg.model = c.model;
        if (c.mode === "cli" || c.mode === "api") cfg.mode = c.mode;
        if (typeof c.max_turns === "number" && c.max_turns > 0) cfg.max_turns = c.max_turns;
        if (typeof c.permission_mode === "string" && c.permission_mode) cfg.permission_mode = c.permission_mode;
        if (typeof c.system_prompt === "string" && c.system_prompt.trim()) cfg.system_prompt = c.system_prompt;
        if (Object.keys(cfg).length === 0) cfg = null; // 全空 = 回退默认
      }
      try {
        saveLifecycleAgent(p.name as string, cfg);
        emitBus({ type: "config:updated", payload: {} });
        return { ok: true };
      } catch (e: unknown) {
        throw new RpcError("SAVE_FAILED", e instanceof Error ? e.message : String(e));
      }
    },
  });

  // agents.get / create / update / delete 已移除（Phase 3：命名复用 agent 机制删除）。

  registerRpcMethod({
    method: "agents.dryRun",
    description: "一次性试跑一个内联 agent 配置（UI 调试）；prompt 必填，agent 为内联配置对象（provider/model/system_prompt...，可省略走 DEFAULT_AGENT），返回 text + usage",
    handler: async (params) => {
      const p = asObj(params);
      if (typeof p.prompt !== "string" || !p.prompt.trim()) {
        throw new RpcError("INVALID_PARAM", "prompt 不能为空");
      }
      // 内联配置：优先取 p.agent（对象），向后兼容顶层 provider/model/... 字段
      const inline: Record<string, unknown> =
        p.agent && typeof p.agent === "object" && !Array.isArray(p.agent)
          ? (p.agent as Record<string, unknown>)
          : {
              ...(typeof p.provider === "string" ? { provider: p.provider } : {}),
              ...(typeof p.model === "string" ? { model: p.model } : {}),
              ...(typeof p.system_prompt === "string" ? { system_prompt: p.system_prompt } : {}),
              ...(typeof p.max_turns === "number" ? { max_turns: p.max_turns } : {}),
              ...(typeof p.permission_mode === "string" ? { permission_mode: p.permission_mode } : {}),
            };

      const merged: Record<string, unknown> = { ...DEFAULT_AGENT, ...inline };
      const provider = (merged["provider"] as string | undefined) ?? DEFAULT_AGENT.provider;
      merged["provider"] = provider;
      if (!merged["model"]) {
        const providerCfg = loadProviders()[provider as ProviderName];
        if (providerCfg?.default_model) merged["model"] = providerCfg.default_model;
      }
      merged["name"] = (typeof merged["name"] === "string" && merged["name"]) ? merged["name"] : "dry-run";

      let agent: ReturnType<typeof createAgent> | null = null;
      try {
        agent = createAgent(merged as Parameters<typeof createAgent>[0]);
        const started = Date.now();
        const result = await agent.run(p.prompt, {
          additional_system: typeof p.additional_system === "string" ? p.additional_system : undefined,
        });
        return { ok: true, elapsed_ms: Date.now() - started, result };
      } catch (e: unknown) {
        throw new RpcError("DRY_RUN_FAILED", e instanceof Error ? e.message : String(e));
      } finally {
        if (agent) { try { await agent.close(); } catch { /* ignore */ } }
      }
    },
  });

}

function registerSandboxSetupRpc(): void {
  // ── 第八批：sandbox + defaults + setup mutation（8 个） ──

  registerRpcMethod({
    method: "sandboxes.tree",
    description: "列任务 sandbox 子目录。root=artifacts（产物归档，默认）/ workspace（代码 clone 工作树）",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      const relPath = typeof p.path === "string" ? p.path : "";
      const root = p.root === "workspace" ? "workspace" as const : "artifacts" as const;
      try {
        return { path: relPath, entries: listSandboxDir(p.id, relPath, root) };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        // 目录懒创建/已清理：任务早期、重跑清空、终态释放后不存在是常态，返回空列表
        // 让 UI 显示空态，而不是红色报错吓用户
        if (/不存在|ENOENT/i.test(msg)) return { path: relPath, entries: [] };
        throw new RpcError("INVALID_PARAM", msg);
      }
    },
  });

  registerRpcMethod({
    method: "sandboxes.file",
    description: "读 sandbox 内单个文件（text）。root 同 sandboxes.tree",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      if (typeof p.path !== "string" || !p.path) throw new RpcError("INVALID_PARAM", "需要 path");
      const root = p.root === "workspace" ? "workspace" as const : "artifacts" as const;
      try {
        return readSandboxFile(p.id, p.path, root);
      } catch (e: unknown) {
        throw new RpcError("INVALID_PARAM", e instanceof Error ? e.message : String(e));
      }
    },
  });

  registerRpcMethod({
    method: "sandboxes.delete",
    description: "释放某任务沙盒（workspace 共用 clone + artifacts/ 产物；仅终态任务）",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      try {
        const { removed } = releaseTaskSandboxAction(p.id);
        return { ok: true, removed };
      } catch (e: unknown) {
        if (e instanceof TaskActionError) throw new RpcError(e.code, e.message);
        throw new RpcError("INTERNAL", e instanceof Error ? e.message : String(e));
      }
    },
  });

  registerRpcMethod({
    method: "sandboxes.usage",
    description: "扫描所有任务 sandbox 占用（Dashboard 用）",
    handler: () => {
      const list = scanTaskSandboxes();
      const total = list.reduce((a, it) => a + it.size, 0);
      return { total, tasks: list };
    },
  });

  registerRpcMethod({
    method: "defaults.get",
    description: "用户偏好（含 resolved timezone）",
    handler: () => {
      const cfg = loadDefaultsConfig();
      return {
        timezone: cfg.timezone ?? null,
        resolved_timezone: cfg.timezone ?? systemTimezone(),
        system_timezone: systemTimezone(),
      };
    },
  });

  registerRpcMethod({
    method: "agents.defaultAgent",
    description: "phase 省略 agent / 留空字段时兜底的内置 DEFAULT_AGENT（编辑器把它当默认值展示）",
    handler: () => ({ ...DEFAULT_AGENT }),
  });

  registerRpcMethod({
    method: "defaults.save",
    description: "保存用户偏好（目前只有 timezone）",
    handler: (params) => {
      const p = asObj(params);
      const tz = typeof p.timezone === "string" ? p.timezone.trim() : "";
      if (tz && !isValidTimezone(tz)) {
        throw new RpcError("INVALID_PARAM", `时区无效：${tz}`);
      }
      try {
        saveDefaultsConfig({ timezone: tz || undefined });
        emitBus({ type: "config:updated", payload: {} });
        return { ok: true, timezone: tz || null };
      } catch (e: unknown) {
        throw new RpcError("SAVE_FAILED", e instanceof Error ? e.message : String(e));
      }
    },
  });

  registerRpcMethod({
    method: "scheduler.get",
    description: "调度器配置（max_concurrent_tasks，未配置时为 null → 生效默认 1；仅约束 execution run，fix 修复回路例外可瞬时超额）",
    handler: () => {
      const cfg = loadSchedulerConfig();
      return {
        max_concurrent_tasks: cfg.max_concurrent_tasks ?? null,
        effective_max_concurrent_tasks: cfg.max_concurrent_tasks ?? 1,
      };
    },
  });

  registerRpcMethod({
    method: "scheduler.save",
    description: "保存调度器配置（max_concurrent_tasks ≥1 整数；传 null 删除该段回落默认 1）。写后即热生效（调度器每次 tick 现读）",
    handler: (params) => {
      const p = asObj(params);
      const v = p.max_concurrent_tasks;
      if (v !== null && v !== undefined) {
        if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
          throw new RpcError("INVALID_PARAM", `max_concurrent_tasks 必须是 ≥1 的整数，收到：${JSON.stringify(v)}`);
        }
      }
      try {
        saveSchedulerConfig({ max_concurrent_tasks: v ?? undefined });
        emitBus({ type: "config:updated", payload: {} });
        const cfg = loadSchedulerConfig();
        return {
          ok: true,
          max_concurrent_tasks: cfg.max_concurrent_tasks ?? null,
          effective_max_concurrent_tasks: cfg.max_concurrent_tasks ?? 1,
        };
      } catch (e: unknown) {
        throw new RpcError("SAVE_FAILED", e instanceof Error ? e.message : String(e));
      }
    },
  });

  registerRpcMethod({
    method: "setup.dismiss",
    description: "标记 setup 横幅已被用户关闭（不再显示）",
    handler: () => {
      setKv("setup.dismissed", "1");
      return { ok: true };
    },
  });

  registerRpcMethod({
    method: "setup.saveProviders",
    description: "批量保存 provider 配置（与 POST /api/setup/providers 等价），返回最新 level-1 doctor 报告",
    handler: async (params) => {
      const p = asObj(params);
      if (!p.providers || typeof p.providers !== "object" || Array.isArray(p.providers)) {
        throw new RpcError("INVALID_PARAM", "providers must be an object");
      }
      // onboarding 写 config.yaml（doctor 诊断暂仍读 config，P1 务实保留）+ 同步条目表
      for (const [name, cfg] of Object.entries(p.providers as Record<string, unknown>)) {
        if (!(PROVIDER_NAMES as readonly string[]).includes(name)) continue;
        if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) continue;
        const c = cfg as Record<string, unknown>;
        saveProvider(name as ProviderName, c);
        // 同步到 providers 条目（运行时以条目为准）
        const entry = getProviderEntryByName(name);
        if (entry) {
          updateProvider(entry.id, {
            enabled: typeof c.enabled === "boolean" ? c.enabled : undefined,
            default_model: typeof c.default_model === "string" ? c.default_model : undefined,
          });
        }
      }
      return { report: await runChecks({ level: 1 }) };
    },
  });

  // setup.saveAgents 已移除（Phase 3：命名复用 agent 机制删除）。
  // setup 流程不再写命名 agent；agent 配置改为工作流 phase 内联。

  registerRpcMethod({
    method: "setup.saveWorkspaces",
    description: "新建 workspace（首跑向导）；需提供 remote_url，写 DB 前 probeRemote 验证；project_id 缺省则用首个 project 或新建 default",
    handler: (params) => {
      const p = asObj(params);
      const name = typeof p.name === "string" ? p.name.trim() : "";
      const remoteUrl = typeof p.remote_url === "string" ? p.remote_url.trim() : "";
      if (!name || !remoteUrl) throw new RpcError("INVALID_PARAM", "name and remote_url required");
      let projectId = typeof p.project_id === "string" ? p.project_id.trim() : "";
      if (!projectId) {
        const projects = listProjects();
        if (projects.length > 0) {
          projectId = projects[0]!.id;
        } else {
          const proj = coreCreateProject({ id: nextProjectId(), name: "default" });
          projectId = proj.id;
        }
      }
      // 项目:代码库已放开 1:N（迁移 037），不再做 1:1 守卫
      // Fail fast：与 workspaces.create 同款 —— 写 DB 前验证远程可达性 + 探测默认分支
      const gitCfg = loadGitConfig();
      const probe = probeRemote(remoteUrl, gitCfg.token);
      if (!probe.ok) {
        throw new RpcError("REMOTE_UNREACHABLE", `远程仓库不可达：${probe.error ?? "git ls-remote 失败"}。请检查 URL 或在 config.yaml 配置 git.token`);
      }
      const parsed = parseGithubFromRemote(remoteUrl);
      const ws = createWorkspace({
        id: nextWorkspaceId(),
        project_id: projectId,
        alias: name,
        path: "",
        remote_url: remoteUrl,
        default_branch: probe.defaultBranch ?? "main",
        github_owner: parsed?.owner ?? null,
        github_repo: parsed?.repo ?? null,
      });
      return { workspace: ws };
    },
  });

  registerRpcMethod({
    method: "config.save",
    description: "保存 config.yaml 原文 + emit config:updated",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.yaml !== "string") throw new RpcError("INVALID_PARAM", "需要 yaml");
      try {
        saveConfigRaw(p.yaml);
        emitBus({ type: "config:updated", payload: {} });
        return { ok: true };
      } catch (e: unknown) {
        throw new RpcError("INVALID_YAML", e instanceof Error ? e.message : String(e));
      }
    },
  });

}

function registerMiscMutationRpc(): void {
  // ── 第十批：收尾（decide + daemon.log + projects mutation + sessions，10 个） ──

  registerRpcMethod({
    method: "tasks.decide",
    description: "gate phase 的人工决断（pass / reject / cancel）",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      if (typeof p.decision !== "string") throw new RpcError("INVALID_PARAM", "需要 decision");
      const note = typeof p.note === "string" ? p.note : "";
      try {
        return decideTaskAction(p.id, p.decision, note, {
          phaseIndex, parseDecisionCounts, renderDecisionMd,
        });
      } catch (e: unknown) {
        if (e instanceof TaskActionError) throw new RpcError(e.code, e.message);
        throw e;
      }
    },
  });

  registerRpcMethod({
    method: "daemon.log",
    description: "读 daemon 主日志（tail N 行）",
    handler: (params) => {
      const p = asObj(params);
      const tail = typeof p.tail === "number" ? p.tail : 500;
      return {
        path: getDaemonFileLogPath() ?? null,
        content: readDaemonFileLog(tail),
      };
    },
  });

  registerRpcMethod({
    method: "projects.get",
    description: "按 id 取 Project 详情",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      const project = getProjectById(p.id);
      if (!project) throw new RpcError("NOT_FOUND", "project not found");
      return { project };
    },
  });

  registerRpcMethod({
    method: "projects.create",
    description: "新建 Project",
    handler: (params) => {
      const p = asObj(params);
      const name = typeof p.name === "string" ? p.name.trim() : "";
      if (!name) throw new RpcError("INVALID_PARAM", "name 必填");
      const id = nextProjectId();
      try {
        const project = coreCreateProject({ id, name, description: (p.description as string | null | undefined) ?? null });
        emitBus({ type: "projects:changed", payload: { id: project.id, action: "create" } });
        return { project };
      } catch (e: unknown) {
        const code = (e as { code?: string }).code;
        const msg = e instanceof Error ? e.message : String(e);
        if (code?.startsWith("SQLITE_CONSTRAINT") || msg.toLowerCase().includes("unique")) {
          throw new RpcError("ALREADY_EXISTS", msg);
        }
        throw new RpcError("CREATE_FAILED", msg);
      }
    },
  });

  registerRpcMethod({
    method: "projects.createWithWorkspace",
    description: "原子性创建 Project + 顶层 Workspace（远程可达性先校验，DB 事务 all-or-nothing，alias 冲突静默处理）",
    handler: (params) => {
      const p = asObj(params);

      // ── 参数校验 ──
      const name = typeof p.name === "string" ? p.name.trim() : "";
      if (!name) throw new RpcError("INVALID_PARAM", "name 必填");

      // 解析 remote_url：优先 remote_url，其次从 path 探测（向后兼容）
      let remoteUrl: string | null = null;
      const rawPath = typeof p.path === "string" ? p.path.trim() : "";
      if (typeof p.remote_url === "string" && p.remote_url.trim()) {
        remoteUrl = p.remote_url.trim();
      } else if (rawPath) {
        // 兼容旧调用：有 path 则从本地探测
        const detected = detectWorkspaceGit(rawPath);
        if (detected.remote_url) remoteUrl = detected.remote_url;
      }
      if (!remoteUrl) {
        throw new RpcError("INVALID_PARAM", "请提供 remote_url 或本地 git 仓库 path");
      }

      // Fail fast：写 DB 前验证远程可达性 + 探测默认分支
      const gitCfg = loadGitConfig();
      const probe = probeRemote(remoteUrl, gitCfg.token);
      if (!probe.ok) {
        throw new RpcError("REMOTE_UNREACHABLE", `远程仓库不可达：${probe.error ?? "git ls-remote 失败"}。请检查 URL 或在 config.yaml 配置 git.token`);
      }

      // ── alias 基础值：显式传入优先，否则从 remote_url 推导 ──
      const baseAlias = (typeof p.alias === "string" && p.alias.trim())
        ? p.alias.trim()
        : (remoteUrl.split("/").pop()?.replace(/\.git$/, "") || "workspace");

      // 解析 GitHub owner/repo
      const parsed = parseGithubFromRemote(remoteUrl);
      const defaultBranch = probe.defaultBranch ?? "main";
      const description = (p.description as string | null | undefined) ?? null;

      const db = getDb();
      let project!: ReturnType<typeof coreCreateProject>;
      let workspace!: ReturnType<typeof createWorkspace>;

      // ── 原子性事务：ID 生成 + 双表写入全在事务内 ──
      let _step: "project" | "workspace" = "project";
      try {
        db.transaction(() => {
          const projectId = nextProjectId();
          const workspaceId = nextWorkspaceId();

          // 1. 建项目
          _step = "project";
          project = coreCreateProject({ id: projectId, name, description });

          // 2. alias 去重（事务内，静默追加后缀）
          const alias = generateUniqueAlias(projectId, baseAlias);

          // 3. 建工作区
          _step = "workspace";
          workspace = createWorkspace({
            id: workspaceId,
            project_id: projectId,
            alias,
            path: rawPath || "",
            remote_url: remoteUrl,
            default_branch: defaultBranch,
            github_owner: parsed?.owner ?? null,
            github_repo: parsed?.repo ?? null,
          });
        })();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (_step === "project") {
          throw new RpcError("PROJECT_CREATE_FAILED", `项目创建失败：${msg}`);
        }
        throw new RpcError("WORKSPACE_CREATE_FAILED", `工作区创建失败：${msg}`);
      }

      // ── 双事件通知 ──
      emitBus({ type: "projects:changed", payload: { id: project.id, action: "create" } });
      emitBus({ type: "workspaces:changed", payload: { id: workspace.id, action: "create" } });

      return { project, workspace };
    },
  });

  registerRpcMethod({
    method: "projects.update",
    description: "更新 Project 字段（name / description）",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      if (p.name !== undefined && typeof p.name === "string" && p.name.trim() === "") {
        throw new RpcError("INVALID_PARAM", "name 不能为空");
      }
      const project = coreUpdateProject(p.id, {
        name: typeof p.name === "string" ? p.name.trim() : undefined,
        description: (p.description as string | null | undefined),
      });
      if (!project) throw new RpcError("NOT_FOUND", "project not found");
      emitBus({ type: "projects:changed", payload: { id: project.id, action: "update" } });
      return { project };
    },
  });

  registerRpcMethod({
    method: "projects.delete",
    description: "级联删除 Project（含 requirements + tasks + workspaces）",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      if (p.id === DEFAULT_PROJECT_ID) {
        throw new RpcError("PRECONDITION_FAILED", "默认项目（兜底快捷发包/定时任务）不可删除");
      }
      if (!getProjectById(p.id)) throw new RpcError("NOT_FOUND", "project not found");
      try {
        // 删前先停运行中任务的 agent 进程（best-effort）：让 runner 收敛、释放 sandbox 占用，
        // 再由 coreDeleteProject 强删记录。cancel 同步触发 abort（向子进程发 SIGTERM），但不阻塞
        // 等子进程实际退出 / phase 收敛，故不 sleep。
        const reqs = listRequirementsByProject(p.id);
        cancelTasksForRequirements(reqs.map((r) => r.id));
        coreDeleteProject(p.id);
        emitBus({ type: "projects:changed", payload: { id: p.id, action: "delete" } });
        return { ok: true };
      } catch (e: unknown) {
        throw new RpcError("DELETE_FAILED", e instanceof Error ? e.message : String(e));
      }
    },
  });

  registerRpcMethod({
    method: "projects.workspaces",
    description: "某 project 下的 workspace 列表",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      if (!getProjectById(p.id)) throw new RpcError("NOT_FOUND", "project not found");
      return { workspaces: listWorkspaces({ projectId: p.id }).map((ws) => ({ ...ws, path_exists: !!ws.remote_url })) };
    },
  });

  registerRpcMethod({
    method: "projects.requirements",
    description: "某 project 下的需求列表",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      if (!getProjectById(p.id)) throw new RpcError("NOT_FOUND", "project not found");
      return { requirements: attachWorkspaceIds(listRequirementsByProject(p.id)) };
    },
  });

  registerRpcMethod({
    method: "projects.addWorkspace",
    description: "在 project 下新建 workspace",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      const proj = getProjectById(p.id);
      if (!proj) throw new RpcError("NOT_FOUND", "project not found");
      const alias = typeof p.alias === "string" ? p.alias.trim() : "";
      const pathField = typeof p.path === "string" ? p.path.trim() : "";
      if (!alias || !pathField) throw new RpcError("INVALID_PARAM", "alias 和 path 必填");
      // 服务端兜底探测：未显式给的字段自动从 git 仓库识别（显式值优先）
      const detected = detectWorkspaceGit(pathField);
      const explicitBranch = typeof p.default_branch === "string" && p.default_branch.trim()
        ? p.default_branch.trim() : null;
      let gh_owner = (p.github_owner as string | null | undefined) ?? null;
      let gh_repo = (p.github_repo as string | null | undefined) ?? null;
      if (!gh_owner && !gh_repo && detected.github_owner && detected.github_repo) {
        gh_owner = detected.github_owner;
        gh_repo = detected.github_repo;
      }
      try {
        const workspace = createWorkspace({
          id: nextWorkspaceId(),
          project_id: p.id,
          alias,
          path: pathField,
          default_branch: explicitBranch ?? detected.default_branch ?? "main",
          github_owner: gh_owner,
          github_repo: gh_repo,
        });
        return { workspace };
      } catch (e: unknown) {
        const code = (e as { code?: string }).code;
        const msg = e instanceof Error ? e.message : String(e);
        if (code?.startsWith("SQLITE_CONSTRAINT") || msg.toLowerCase().includes("unique")) {
          throw new RpcError("ALREADY_EXISTS", msg);
        }
        throw new RpcError("CREATE_FAILED", msg);
      }
    },
  });

}

function registerWorkspaceRpc(): void {
  // ── workspaces.* —— Workspace CRUD + submodules / healthcheck ──

  registerRpcMethod({
    method: "workspaces.list",
    description: "列出所有 workspace（与 GET /api/workspaces 等价；返回数组，无 envelope）",
    handler: () => listWorkspaces().map((ws) => ({
      ...ws,
      // 向后兼容：path_exists 改为基于 remote_url 是否填写的简单判断
      path_exists: !!ws.remote_url,
    })),
  });

  registerRpcMethod({
    method: "workspaces.get",
    description: "按 id 取 workspace；不存在抛 NOT_FOUND",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      const ws = getWorkspaceById(p.id);
      if (!ws) throw new RpcError("NOT_FOUND", "workspace not found");
      return ws;
    },
  });

  registerRpcMethod({
    method: "workspaces.detect",
    description: "从本地路径探测 git 信息（默认分支 / 远程地址 / GitHub owner/repo），用于创建表单自动填充；纯读不写库",
    handler: (params) => {
      const p = asObj(params);
      const path = typeof p.path === "string" ? p.path.trim() : "";
      if (!path) throw new RpcError("INVALID_PARAM", "需要 path");
      return detectWorkspaceGit(path);
    },
  });

  registerRpcMethod({
    method: "workspaces.create",
    description: "创建 workspace；需提供 remote_url 或 --github owner/repo；写 DB 前执行 git ls-remote 可达性验证",
    handler: (params) => {
      const p = asObj(params);
      const alias = typeof p.alias === "string" ? p.alias.trim() : "";
      if (!alias) throw new RpcError("INVALID_PARAM", "alias 必填");

      const projectId = typeof p.project_id === "string" ? p.project_id.trim() : "";

      // 解析 remote_url：优先显式传入，其次从 github owner/repo 构造，再回退本地 path 探测
      let remoteUrl: string | null = null;
      if (typeof p.remote_url === "string" && p.remote_url.trim()) {
        remoteUrl = p.remote_url.trim();
      } else if (typeof p.github === "string" && p.github.includes("/")) {
        const [owner, repo] = p.github.split("/");
        remoteUrl = `https://github.com/${owner}/${repo}.git`;
      } else if (typeof p.github_owner === "string" && typeof p.github_repo === "string") {
        remoteUrl = `https://github.com/${p.github_owner}/${p.github_repo}.git`;
      } else if (typeof p.path === "string" && p.path.trim()) {
        // 兼容旧调用：有 path 则从本地探测
        const detected = detectWorkspaceGit(p.path.trim());
        if (detected.remote_url) remoteUrl = detected.remote_url;
      }

      if (!remoteUrl) {
        throw new RpcError("INVALID_PARAM", "请提供 remote_url 或 --github owner/repo（格式：owner/repo）");
      }

      // Fail fast：写 DB 前验证远程可达性 + 探测默认分支
      const gitCfg = loadGitConfig();
      const probe = probeRemote(remoteUrl, gitCfg.token);
      if (!probe.ok) {
        throw new RpcError("REMOTE_UNREACHABLE", `远程仓库不可达：${probe.error ?? "git ls-remote 失败"}。请检查 URL 或在 config.yaml 配置 git.token`);
      }

      // 默认分支：显式指定 > probe 探测 > "main"
      const explicitBranch = typeof p.default_branch === "string" && p.default_branch.trim()
        ? p.default_branch.trim() : null;
      const defaultBranch = explicitBranch ?? probe.defaultBranch ?? "main";

      // 解析 github owner/repo（从 remote_url 中提取）
      let github_owner = (p.github_owner as string | null | undefined) ?? null;
      let github_repo = (p.github_repo as string | null | undefined) ?? null;
      if (!github_owner || !github_repo) {
        const parsed = parseGithubFromRemote(remoteUrl);
        if (parsed) { github_owner = parsed.owner; github_repo = parsed.repo; }
      }

      try {
        const workspace = createWorkspace({
          id: nextWorkspaceId(),
          project_id: projectId,
          alias,
          path: typeof p.path === "string" && p.path.trim() ? p.path.trim() : "",
          remote_url: remoteUrl,
          default_branch: defaultBranch,
          github_owner,
          github_repo,
        });
        return workspace;
      } catch (e: unknown) {
        const code = (e as { code?: string }).code;
        const msg = e instanceof Error ? e.message : String(e);
        if (code?.startsWith("SQLITE_CONSTRAINT") || msg.toLowerCase().includes("unique")) {
          throw new RpcError("ALREADY_EXISTS", msg);
        }
        throw new RpcError("CREATE_FAILED", msg);
      }
    },
  });

  registerRpcMethod({
    method: "workspaces.update",
    description: "更新 workspace 字段（与 PUT /api/workspaces/:id 等价）",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      const existing = getWorkspaceById(p.id);
      if (!existing) throw new RpcError("NOT_FOUND", "workspace not found");
      const patch: Record<string, unknown> = {};
      if (p.alias !== undefined) {
        const trimmed = typeof p.alias === "string" ? p.alias.trim() : "";
        if (!trimmed) throw new RpcError("INVALID_PARAM", "alias 不能为空");
        patch.alias = trimmed;
      }
      if (p.path !== undefined) {
        const trimmed = typeof p.path === "string" ? p.path.trim() : "";
        if (trimmed) patch.path = trimmed;
      }
      if (p.remote_url !== undefined) {
        const rawUrl = typeof p.remote_url === "string" ? p.remote_url.trim() : "";
        if (!rawUrl) throw new RpcError("INVALID_PARAM", "remote_url 不能为空字符串（传 null 可清空）");
        // 验证新 remote_url 可达性（与 create 对称）
        const gitCfg = loadGitConfig();
        const probe = probeRemote(rawUrl, gitCfg.token);
        if (!probe.ok) {
          throw new RpcError("REMOTE_UNREACHABLE", `远程仓库不可达：${probe.error ?? "git ls-remote 失败"}。请检查 URL 或 config.yaml 的 git.token`);
        }
        patch.remote_url = rawUrl;
        // 若 default_branch 未显式指定，用 probe 探测到的默认分支
        if (p.default_branch === undefined && probe.defaultBranch) {
          patch.default_branch = probe.defaultBranch;
        }
      }
      if (p.default_branch !== undefined) {
        const trimmed = typeof p.default_branch === "string" ? p.default_branch.trim() : "";
        if (trimmed) patch.default_branch = trimmed;
      }
      if (p.github_owner !== undefined) patch.github_owner = p.github_owner;
      if (p.github_repo !== undefined) patch.github_repo = p.github_repo;
      try {
        const workspace = updateWorkspace(p.id, patch);
        return workspace;
      } catch (e: unknown) {
        const code = (e as { code?: string }).code;
        const msg = e instanceof Error ? e.message : String(e);
        if (code?.startsWith("SQLITE_CONSTRAINT") || msg.toLowerCase().includes("unique")) {
          throw new RpcError("ALREADY_EXISTS", msg);
        }
        throw new RpcError("UPDATE_FAILED", msg);
      }
    },
  });

  registerRpcMethod({
    method: "workspaces.delete",
    description: "删除 workspace；默认拒绝删有需求关联的 workspace，要求 force=true 才能级联清空 requirements.workspace_id",
    handler: async (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      const existing = getWorkspaceById(p.id);
      if (!existing) throw new RpcError("NOT_FOUND", "workspace not found");
      // 默认 in_use 检查 —— 防止 web/CLI 误删带走一批需求的 workspace_id
      // 调用方必须显式 force: true 才能继续（前端弹 confirm dialog）
      if (!p.force) {
        const { getDb } = await import("../core/db");
        // workspace_id 缓存列 + 集合表（requirement_workspaces）都算引用，UNION 按需求去重
        const row = getDb()
          .query<{ n: number }, [string, string]>(
            "SELECT COUNT(*) AS n FROM (" +
              "SELECT id FROM requirements WHERE workspace_id = ? " +
              "UNION SELECT requirement_id FROM requirement_workspaces WHERE workspace_id = ?" +
            ")",
          )
          .get(p.id, p.id);
        const affected = row?.n ?? 0;
        if (affected > 0) {
          throw new RpcError(
            "IN_USE",
            `${affected} 条需求关联此 workspace；带 force=true 后会把这些 requirement.workspace_id 置 NULL（需求保留）`,
          );
        }
      }
      deleteWorkspace(p.id);
      return { ok: true };
    },
  });

  registerRpcMethod({
    method: "workspaces.listSubmodules",
    description: "列出 workspace 的子模块（与 GET /api/workspaces/:id/submodules 等价）",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      const ws = getWorkspaceById(p.id);
      if (!ws) throw new RpcError("NOT_FOUND", "workspace not found");
      return { submodules: listSubmodules(p.id) };
    },
  });

  registerRpcMethod({
    method: "workspaces.healthcheck",
    description: "检查 workspace 健康状态 + 自动发现子模块（与 POST /api/workspaces/:id/healthcheck 等价）",
    handler: async (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      const workspace = getWorkspaceById(p.id);
      if (!workspace) throw new RpcError("NOT_FOUND", "workspace not found");
      const gitCfg = loadGitConfig();
      const health = await checkWorkspaceHealth(workspace, gitCfg.token);
      if (health.healthy && !workspace.parent_workspace_id) {
        try {
          const dr = discoverSubmodules(workspace.id);
          return {
            healthy: true,
            issues: health.issues,
            submodules: {
              added: dr.added.map((r) => ({ id: r.id, alias: r.alias, path: r.submodule_path })),
              existing: dr.existing.length,
              warnings: dr.warnings,
            },
          };
        } catch (e: unknown) {
          return {
            healthy: true,
            issues: health.issues,
            submodules: { error: (e as Error).message },
          };
        }
      }
      return { healthy: health.healthy, issues: health.issues };
    },
  });

  registerRpcMethod({
    method: "workspaces.rediscoverSubmodules",
    description: "重新扫描 workspace 子模块（与 POST /api/workspaces/:id/rediscover-submodules 等价）",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      const workspace = getWorkspaceById(p.id);
      if (!workspace) throw new RpcError("NOT_FOUND", "workspace not found");
      if (workspace.parent_workspace_id) {
        throw new RpcError("INVALID_PARAM", "子模块自身不能再发现子模块（不支持嵌套）");
      }
      try {
        const r = discoverSubmodules(p.id);
        return {
          added: r.added.map((x) => ({ id: x.id, alias: x.alias, submodule_path: x.submodule_path })),
          existing_count: r.existing.length,
          warnings: r.warnings,
        };
      } catch (e: unknown) {
        throw new RpcError("DISCOVER_FAILED", (e as Error).message);
      }
    },
  });

}

function registerSessionEtcRpc(): void {
  // ── sessions（chat 历史会话查询 / 删除；流式 chat 接口留 HTTP） ──

  registerRpcMethod({
    method: "sessions.list",
    description: "列出所有 chat 会话",
    handler: () => listChatSessions(),
  });

  registerRpcMethod({
    method: "sessions.get",
    description: "取单个 chat 会话详情（含 messages）",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      try {
        const manifest = readSessionManifest(p.id);
        const messages = readSessionMessages(p.id);
        return { ...manifest, messages };
      } catch (e: unknown) {
        throw new RpcError("NOT_FOUND", e instanceof Error ? e.message : String(e));
      }
    },
  });

  registerRpcMethod({
    method: "sessions.delete",
    description: "删除 chat 会话",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      const ok = deleteChatSession(p.id);
      if (!ok) throw new RpcError("NOT_FOUND", "session not found");
      return { ok: true };
    },
  });

  // ── P4: connection-scoped 订阅走 RPC method（替代 legacy frame） ──
  //
  // 区别于其他 method：handler 需要 ctx.ws 操作 per-conn 订阅 set + 触发
  // snapshot 推送。非 WS transport（HTTP）调用直接抛 NO_CONNECTION，
  // 因为订阅是有状态长连接概念，HTTP 没意义。

  registerRpcMethod({
    method: "channels.subscribe",
    description: "订阅 channels（per-connection state；首次订阅触发 snapshot 推送）",
    handler: (params, ctx) => {
      const p = asObj(params);
      if (!Array.isArray(p.channels)) {
        throw new RpcError("INVALID_PARAM", "channels 必须是 string[]");
      }
      const channels = p.channels.filter((c): c is string => typeof c === "string");
      if (!ctx?.ws) {
        throw new RpcError("NO_CONNECTION", "channels.subscribe 只能在 WS 连接上调用");
      }
      wsManager.subscribeForClient(ctx.ws, channels);
      return { ok: true, channels };
    },
  });

  registerRpcMethod({
    method: "channels.unsubscribe",
    description: "取消订阅 channels",
    handler: (params, ctx) => {
      const p = asObj(params);
      if (!Array.isArray(p.channels)) {
        throw new RpcError("INVALID_PARAM", "channels 必须是 string[]");
      }
      const channels = p.channels.filter((c): c is string => typeof c === "string");
      if (!ctx?.ws) {
        throw new RpcError("NO_CONNECTION", "channels.unsubscribe 只能在 WS 连接上调用");
      }
      wsManager.unsubscribeForClient(ctx.ws, channels);
      return { ok: true, channels };
    },
  });

  // ── API Keys CRUD ──

  registerRpcMethod({
    method: "apiKeys.list",
    description: "列出所有已配置的 API key（脱敏）",
    handler: () => listApiKeys(),
  });

  registerRpcMethod({
    method: "apiKeys.set",
    description: "写入/更新某个 provider 的 API key",
    handler: async (params) => {
      const p = asObj(params);
      if (typeof p.provider !== "string" || !p.provider) {
        throw new RpcError("INVALID_PARAM", "需要 provider");
      }
      if (typeof p.key !== "string" || !p.key) {
        throw new RpcError("INVALID_PARAM", "需要 key");
      }
      await setApiKey(p.provider, p.key);
      return { ok: true };
    },
  });

  registerRpcMethod({
    method: "apiKeys.delete",
    description: "删除某个 provider 的 API key",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.provider !== "string" || !p.provider) {
        throw new RpcError("INVALID_PARAM", "需要 provider");
      }
      deleteApiKey(p.provider);
      return { ok: true };
    },
  });

  // ── providers.listExtended：provider 条目 + API key 状态富集（条目化后表后端） ──

  registerRpcMethod({
    method: "providers.listExtended",
    description: "provider 条目完整信息：条目字段（id/type/subtype/enabled/origin）+ API key 状态 + 旧 shape 兼容（supports_cli/api_only/default_mode）",
    handler: () => {
      const apiKeys = listApiKeys();
      const keyMap = new Map(apiKeys.map((k) => [k.provider, k]));
      const envFallback = (
        provider: string,
        customEnvKeyName?: string,
      ): { key_hint: string; source: "env" } | undefined => {
        const envValue = process.env[envKeyNameForProvider(provider, customEnvKeyName)];
        return envValue ? { key_hint: maskApiKey(envValue), source: "env" } : undefined;
      };

      return listProviderEntries().map((p) => {
        const isCli = p.type === "cli";
        // API key 状态只对 api 类型有意义
        const keyInfo = isCli ? undefined : (keyMap.get(p.name) || envFallback(p.name, p.env_key_name ?? undefined));
        return {
          // 条目字段（新）
          id: p.id,
          name: p.name,
          display_name: p.display_name,
          type: p.type,
          subtype: p.subtype,
          enabled: p.enabled !== 0,
          origin: p.origin,
          cli_status: p.cli_status,
          cli_version: p.cli_version,
          base_url: p.base_url ?? undefined,
          env_key_name: p.env_key_name ?? undefined,
          default_model: p.default_model ?? undefined,
          // 旧 shape 兼容（PhaseAgentEditor / 过渡期提供商页 / Setup）
          supports_cli: isCli,
          supports_api: !isCli,
          api_only: !isCli,
          default_mode: p.type,
          has_api_key: !!keyInfo,
          key_hint: keyInfo?.key_hint,
          key_source: keyInfo?.source,
        };
      });
    },
  });

  // ── provider 条目 CRUD（条目化重构 P1） ──

  registerRpcMethod({
    method: "providers.create",
    description: "新建 provider 条目（type=cli 时探测本地 CLI 落 cli_status）",
    handler: async (params) => {
      const p = asObj(params);
      const name = typeof p.name === "string" ? p.name.trim() : "";
      const type = p.type as ProviderType;
      const subtype = typeof p.subtype === "string" ? p.subtype.trim() : "";
      if (!name) throw new RpcError("INVALID_PARAM", "需要 name");
      if (type !== "cli" && type !== "api") throw new RpcError("INVALID_PARAM", "type 需为 cli / api");
      if (!subtype) throw new RpcError("INVALID_PARAM", "需要 subtype");
      try {
        const entry = createProvider({
          name,
          display_name: typeof p.display_name === "string" && p.display_name.trim() ? p.display_name.trim() : name,
          type,
          subtype,
          cli_bin: typeof p.cli_bin === "string" ? p.cli_bin : null,
          cli_login_cmd: typeof p.cli_login_cmd === "string" ? p.cli_login_cmd : null,
          base_url: typeof p.base_url === "string" ? p.base_url : null,
          env_key_name: typeof p.env_key_name === "string" ? p.env_key_name : null,
          default_model: typeof p.default_model === "string" ? p.default_model : null,
          origin: p.origin === "template" ? "template" : "user",
        });
        // CLI 类型：添加时探测本地可用性落库
        if (type === "cli") {
          const probe = await probeCli(subtype, entry.cli_bin ?? undefined);
          setProviderCliStatus(entry.id, probe.status, probe.version ?? null);
        }
        emitBus({ type: "config:updated", payload: {} });
        return { provider: getProviderById(entry.id) };
      } catch (e: unknown) {
        throw new RpcError("SAVE_FAILED", e instanceof Error ? e.message : String(e));
      }
    },
  });

  registerRpcMethod({
    method: "providers.update",
    description: "更新 provider 条目（display_name / default_model / base_url / env_key_name / enabled）",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      if (!getProviderById(p.id)) throw new RpcError("NOT_FOUND", `provider 条目不存在：${p.id}`);
      try {
        const updated = updateProvider(p.id, {
          display_name: typeof p.display_name === "string" ? p.display_name : undefined,
          base_url: p.base_url === null || typeof p.base_url === "string" ? (p.base_url as string | null) : undefined,
          env_key_name: p.env_key_name === null || typeof p.env_key_name === "string" ? (p.env_key_name as string | null) : undefined,
          default_model: p.default_model === null || typeof p.default_model === "string" ? (p.default_model as string | null) : undefined,
          enabled: typeof p.enabled === "boolean" ? p.enabled : undefined,
        });
        emitBus({ type: "config:updated", payload: {} });
        return { provider: updated };
      } catch (e: unknown) {
        throw new RpcError("SAVE_FAILED", e instanceof Error ? e.message : String(e));
      }
    },
  });

  registerRpcMethod({
    method: "providers.delete",
    description: "删除 provider 条目（P1：硬删 + 有工作流引用则拒删；软删降级 P2）",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      const entry = getProviderById(p.id);
      if (!entry) throw new RpcError("NOT_FOUND", `provider 条目不存在：${p.id}`);
      // P1 引用守卫：被工作流引用则拒删（软删降级留 P2）
      const refs = listWorkflowsUsingProvider(entry.name);
      if (refs.length > 0 && !p.force) {
        const names = refs.map((r) => r.workflow).join("、");
        throw new RpcError("PRECONDITION_FAILED",
          `provider「${entry.name}」被工作流引用（${names}），删除会让这些工作流无法使用。` +
          `请先改这些工作流的 provider，或传 force 强删。`);
      }
      deleteProvider(p.id);
      emitBus({ type: "config:updated", payload: {} });
      return { ok: true };
    },
  });

  registerRpcMethod({
    method: "providers.templates",
    description: "可一键添加的 compat 模板（DeepSeek/Kimi/MiniMax 内置预置，预填 base_url + 建议模型）",
    handler: () => {
      return Object.entries(BUILTIN_COMPAT_PROVIDERS).map(([name, preset]) => ({
        name,
        display_name: preset.display_name,
        type: "api" as const,
        subtype: "openai-compat" as const,
        base_url: preset.base_url,
        default_model: preset.default_model,
        env_key_name: preset.env_key,
      }));
    },
  });

  registerRpcMethod({
    method: "providers.detectCli",
    description: "重新探测某 cli 条目的本地可用性，落 cli_status",
    handler: async (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      const entry = getProviderById(p.id);
      if (!entry) throw new RpcError("NOT_FOUND", `provider 条目不存在：${p.id}`);
      if (entry.type !== "cli") throw new RpcError("INVALID_PARAM", "仅 cli 类型条目可探测");
      const probe = await probeCli(entry.subtype, entry.cli_bin ?? undefined);
      setProviderCliStatus(entry.id, probe.status, probe.version ?? null);
      return { status: probe.status, version: probe.version, install_hint: probe.install_hint, error: probe.error };
    },
  });
}

/** 注册全部内核 RPC method（按域分组调用，原单个 2500 行函数已拆为下列子函数）。 */
export function registerCoreRpcMethods(): void {
  // 幂等守卫（原在函数体首行）：已注册则跳过，防测试 / 多次调用重复注册
  if (hasRpcMethod("daemon.status")) return;
  registerCoreQueryRpc();
  registerTaskRpc();
  registerWorkflowRpc();
  registerRequirementRpc();
  registerProviderAgentRpc();
  registerSandboxSetupRpc();
  registerMiscMutationRpc();
  registerWorkspaceRpc();
  registerSessionEtcRpc();
}

function countTasksByStatus(): Record<string, number> {
  const all = listTasks({});
  const out: Record<string, number> = {};
  for (const t of all) {
    const s = (t as { status: string }).status;
    out[s] = (out[s] ?? 0) + 1;
  }
  return out;
}
