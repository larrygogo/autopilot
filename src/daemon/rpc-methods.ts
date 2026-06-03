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
  getTask,
  getKv,
  getTaskLogs,
  getSubTasks,
  listTaskPhaseEvents,
  getWorkflowPhaseStats,
} from "../core/db";
import {
  listWorkflows,
  getWorkflowYaml as registryGetWorkflowYaml,
  getWorkflowTs as registryGetWorkflowTs,
  saveWorkflowYaml,
  deleteWorkflowDir,
  reload as reloadRegistry,
} from "../core/registry";
import { updateDbWorkflow, deleteDbWorkflow, getWorkflowFromDb, listWorkflowsInDb } from "../core/workflows";
import { listWorkflowTemplates, scanWorkflowHealth } from "../core/workflow-templates";
import { runWorkflowAuthor, saveAuthoredWorkflow as saveAuthoredWf } from "./workflow-author";
import {
  listSchedules as coreListSchedules,
  getSchedule as coreGetSchedule,
  createSchedule as coreCreateSchedule,
  updateSchedule as coreUpdateSchedule,
  deleteSchedule as coreDeleteSchedule,
  markScheduleFired,
  systemTimezone,
  isValidTimezone,
  type ScheduleType,
} from "../core/schedules";
import { loadDefaultsConfig, saveDefaultsConfig, saveConfigRaw, loadDaemonConfig, saveDaemonConfig } from "../core/config";
import { requestRestart } from "./index";
import { loadApiToken } from "../core/api-token";
import {
  listWorkspaceDir,
  readWorkspaceFile,
  deleteTaskWorkspace,
  scanTaskWorkspaces,
} from "../core/workspace";
import { setKv } from "../core/db";
import { discover as registryDiscover, getWorkflow as registryGetWorkflow } from "../core/registry";
import { getWorkflowView, computeWorkflowGraph, WorkflowViewError } from "./workflow-views";
import { emit as emitBus } from "../core/event-bus";
import {
  listProjects,
  getProjectById,
  createProject as coreCreateProject,
  updateProject as coreUpdateProject,
  deleteProject as coreDeleteProject,
  nextProjectId,
} from "../core/projects";
import { listRequirementsByProject } from "../core/requirements";
import { listCodebases, getCodebaseById, createCodebase, updateCodebase, deleteCodebase, nextCodebaseId } from "../core/codebases";
import { listSubmodules, discoverSubmodules } from "../core/submodules";
import { checkCodebaseHealth, detectCodebaseGit } from "../core/codebase-health";
import {
  listSessions as listChatSessions,
  deleteSession as deleteChatSession,
  readManifest as readSessionManifest,
  readMessages as readSessionMessages,
} from "../core/sessions";
import { readDaemonFileLog, getDaemonFileLogPath } from "../core/logger";
import {
  listRequirements as coreListRequirements,
  getRequirementById,
  createRequirement as coreCreateRequirement,
  updateRequirement as coreUpdateRequirement,
  deleteRequirement as coreDeleteRequirement,
  setRequirementStatus,
  nextRequirementId,
  finishClarification,
  type Requirement,
} from "../core/requirements";
import { listSubPrs } from "../core/requirement-sub-prs";
import { listSpecRevisionsByRequirement } from "../core/spec-revisions";
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
} from "../core/requirement-comments";
import {
  loadProviders,
  loadConfigRaw,
  PROVIDER_NAMES,
  saveProvider,
  type ProviderName,
} from "../core/config";
import { detectProviderCli, detectAllProviders } from "../agents/cli-status";
import { listProviderModels } from "../agents/model-list";
import { createAgent } from "../agents/registry";
import { DEFAULT_AGENT } from "../core/agent-defaults";
import { runChecks } from "../core/doctor";
import {
  listPhaseLogs,
  readPhaseLog,
  readTaskEvents,
  listAgentCalls,
  getAgentCall,
} from "../core/task-logs";
import { getNowAggregator } from "./routes-now";
import { dismissCard as coreDismissCard } from "../core/now-dismiss";
import { phaseIndex, parseDecisionCounts, renderDecisionMd } from "./routes";
import { computeTaskOutcome } from "./task-outcome";
import {
  cancelTaskAction,
  restartTaskAction,
  answerTaskAction,
  decideTaskAction,
  TaskActionError,
} from "./task-actions";
import { startTaskFromTemplate, StartTaskError } from "../core/task-factory";
import { cascadeDeleteTask, DeleteTaskError } from "../core/task-delete";
import { registerRpcMethod, hasRpcMethod, RpcError } from "./rpc";
import { wsManager } from "./ws";
import { VERSION, GIT_SHA, STARTED_AT_ISO } from "../index";

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

/** 在 daemon 启动早期调用一次。重复调用幂等（检查 daemon.status 是否已注册）。 */
export function registerCoreRpcMethods(): void {
  if (hasRpcMethod("daemon.status")) return;

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
    }),
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
      const cur = loadDaemonConfig();
      saveDaemonConfig({ ...cur, host });
      return { ok: true, host, restart_required: true };
    },
  });

  registerRpcMethod({
    method: "daemon.restart",
    description: "请求 supervisor 重启 daemon（exit code 75 触发 respawn）；裸跑模式下退化为 stop",
    handler: () => {
      const ok = requestRestart(150);
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
    description: "返回三个内置 provider 的配置（agent_count 恒为 0：命名复用 agent 机制已移除，保留字段仅为 Web shape 兼容）",
    handler: () => {
      const providers = loadProviders();
      return PROVIDER_NAMES.map((name) => ({
        name,
        ...providers[name],
        // 命名复用 agent 已移除；保留 agent_count 字段（恒 0）兼容 Web 旧 shape
        agent_count: 0,
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

  registerRpcMethod({
    method: "now.cards",
    description: "Now 页卡片列表（daemon 未启动时返回空数组）",
    handler: () => {
      const agg = getNowAggregator();
      return agg ? agg.getCards() : [];
    },
  });

  registerRpcMethod({
    method: "now.dismissCard",
    description: "标记 Now 卡片已忽略（持久化 dismiss + 同步 aggregator 内存）",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      coreDismissCard(p.id);
      // 跟原 HTTP handler 行为一致：同步内存 aggregator，让 markDismissed 触发 emit
      const agg = getNowAggregator();
      if (agg) agg.markDismissed(p.id);
      return { ok: true };
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
    description: "列出任务 workspace 下已有的阶段日志文件元信息",
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

  registerRpcMethod({
    method: "tasks.events",
    description: "任务事件流（JSONL 解析后），可选 tail",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      const tail = typeof p.tail === "number" ? p.tail : undefined;
      try {
        return readTaskEvents(p.id, tail !== undefined ? { tail } : undefined);
      } catch (e: unknown) {
        throw new RpcError("INVALID_PARAM", e instanceof Error ? e.message : String(e));
      }
    },
  });

  registerRpcMethod({
    method: "tasks.subtasks",
    description: "任务下挂的子任务（仅 parent_task_id 关系）",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      return getSubTasks(p.id);
    },
  });

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
    description: "从 workflow + requirement 启动新任务（POST /api/tasks 等价）",
    handler: async (params) => {
      const p = asObj(params);
      try {
        // body 字段透传给 setup_func；body schema 由调用方负责，这里不再校验
        return await startTaskFromTemplate(p as Parameters<typeof startTaskFromTemplate>[0]);
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
      const { sendPromptToTask } = await import("../core/task-send-prompt");
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
    description: "一句话发包：跳过 project / requirement / workflow 选择，直接跑 ad-hoc workflow（spec §3.7）",
    handler: async (params) => {
      const p = asObj(params);
      const prompt = typeof p.prompt === "string" ? p.prompt.trim() : "";
      if (!prompt) throw new RpcError("INVALID_PARAM", "需要 prompt");
      const workflow = typeof p.workflow === "string" && p.workflow.trim() ? p.workflow.trim() : "ad-hoc";
      const opts: Parameters<typeof startTaskFromTemplate>[0] = {
        workflow,
        // ad-hoc 工作流通过 prompt-runner 的 ${REQUIREMENT} 占位读 requirement
        requirement: prompt,
        // 取 prompt 第一行（不超 60 字）当 task title 方便 UI 显示
        title: prompt.split("\n")[0].slice(0, 60),
      };
      // 可选 codebase 透传：让 workspace.git=true 时能起 git worktree
      // alias 在此 handler 解析为 codebase_id（startTaskFromTemplate 不解析 alias）
      if (typeof p.codebase_id === "string" && p.codebase_id.trim()) {
        (opts as Record<string, unknown>).codebase_id = p.codebase_id.trim();
      } else if (typeof p.codebase_alias === "string" && p.codebase_alias.trim()) {
        const alias = p.codebase_alias.trim();
        const codebases = await import("../core/codebases");
        const cb = codebases.listCodebases({ includeSubmodules: true }).find(c => c.alias === alias);
        if (!cb) throw new RpcError("NOT_FOUND", `找不到别名为 "${alias}" 的 codebase`);
        (opts as Record<string, unknown>).codebase_id = cb.id;
      }
      try {
        return await startTaskFromTemplate(opts);
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
    method: "workflows.getYaml",
    description: "读取 workflow.yaml 原文（db 来源直接读 yaml_content / file 读磁盘）",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.name !== "string" || !p.name) throw new RpcError("INVALID_PARAM", "需要 name");
      const row = getWorkflowFromDb(p.name);
      if (row && row.source === "db") {
        return { yaml: row.yaml_content };
      }
      const yaml = registryGetWorkflowYaml(p.name);
      if (yaml === null) throw new RpcError("NOT_FOUND", "Workflow not found");
      return { yaml };
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

  registerRpcMethod({
    method: "workflows.scanHealth",
    description: "扫描 yaml.name 跟目录名不一致 / 重名碰撞",
    handler: () => scanWorkflowHealth(),
  });

  registerRpcMethod({
    method: "workflows.exportBundle",
    description: "导出为 JSON bundle（yaml + ts）便于分享",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.name !== "string" || !p.name) throw new RpcError("INVALID_PARAM", "需要 name");
      const yaml = registryGetWorkflowYaml(p.name);
      if (yaml === null) throw new RpcError("NOT_FOUND", "Workflow not found");
      const ts = registryGetWorkflowTs(p.name);
      return {
        version: 1,
        name: p.name,
        yaml,
        ts: ts ?? null,
        exported_at: new Date().toISOString(),
      };
    },
  });

  registerRpcMethod({
    method: "workflows.author",
    description: "AI 生成 workflow.yaml + ts（不落盘，返回预览）",
    handler: async (params) => {
      const p = asObj(params);
      if (typeof p.description !== "string" || !p.description.trim()) {
        throw new RpcError("INVALID_PARAM", "需要 description");
      }
      return await runWorkflowAuthor({
        description: p.description,
        prior_yaml: typeof p.prior_yaml === "string" ? p.prior_yaml : undefined,
        prior_ts: typeof p.prior_ts === "string" ? p.prior_ts : undefined,
      });
    },
  });

  registerRpcMethod({
    method: "workflows.saveAuthored",
    description: "把 AI 生成的 workflow 落盘 + reload + emit",
    handler: async (params) => {
      const p = asObj(params);
      if (typeof p.name !== "string" || !p.name || typeof p.yaml !== "string" || typeof p.ts !== "string") {
        throw new RpcError("INVALID_PARAM", "需要 name + yaml + ts");
      }
      try {
        saveAuthoredWf(p.name, p.yaml, p.ts);
        await reloadRegistry();
        emitBus({ type: "workflow:reloaded", payload: {} });
        return { ok: true, name: p.name };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        const code = msg.includes("already exists") ? "ALREADY_EXISTS"
          : msg.includes("只允许") ? "INVALID_NAME"
          : "SAVE_FAILED";
        throw new RpcError(code, msg);
      }
    },
  });

  registerRpcMethod({
    method: "workflows.importBundle",
    description: "从 JSON bundle 创建新工作流（复用 saveAuthored 的落盘逻辑）",
    handler: async (params) => {
      const p = asObj(params);
      if (typeof p.name !== "string" || typeof p.yaml !== "string") {
        throw new RpcError("INVALID_PARAM", "需要 name + yaml");
      }
      if (!/^[\w.\-]+$/.test(p.name)) {
        throw new RpcError("INVALID_NAME", "name 只允许字母 / 数字 / . _ -");
      }
      try {
        saveAuthoredWf(p.name, p.yaml, typeof p.ts === "string" ? p.ts : "");
        await reloadRegistry();
        emitBus({ type: "workflow:reloaded", payload: {} });
        return { ok: true, name: p.name };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        const code = msg.includes("already exists") ? "ALREADY_EXISTS" : "SAVE_FAILED";
        throw new RpcError(code, msg);
      }
    },
  });

  registerRpcMethod({
    method: "workflows.saveYaml",
    description: "保存 workflow.yaml（db 来源走 updateDbWorkflow，file 写文件）",
    handler: async (params) => {
      const p = asObj(params);
      if (typeof p.name !== "string" || !p.name) throw new RpcError("INVALID_PARAM", "需要 name");
      if (typeof p.yaml !== "string") throw new RpcError("INVALID_PARAM", "需要 yaml");
      const row = getWorkflowFromDb(p.name);
      try {
        if (row && row.source === "db") {
          updateDbWorkflow(p.name, { yaml_content: p.yaml });
        } else {
          saveWorkflowYaml(p.name, p.yaml);
        }
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
        if (row && row.source === "db") {
          deleteDbWorkflow(p.name);
        } else {
          const ok = deleteWorkflowDir(p.name);
          if (!ok) throw new RpcError("NOT_FOUND", "Workflow not found");
        }
        await reloadRegistry();
        emitBus({ type: "workflow:reloaded", payload: {} });
        return { ok: true };
      } catch (e: unknown) {
        if (e instanceof RpcError) throw e;
        throw new RpcError("DELETE_FAILED", e instanceof Error ? e.message : String(e));
      }
    },
  });

  // ── 第六批：requirements.* 域（16 个） ──

  registerRpcMethod({
    method: "requirements.list",
    description: "列出需求，可选 codebase_id / project_id / status 过滤",
    handler: (params) => {
      const p = asObj(params);
      const codebase_id = typeof p.codebase_id === "string" ? p.codebase_id : undefined;
      const project_id = typeof p.project_id === "string" ? p.project_id : undefined;
      const status = typeof p.status === "string" ? p.status : undefined;
      return {
        requirements: coreListRequirements({ codebase_id, project_id, status }),
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
        requirement: r,
        comments: listComments(p.id),
      };
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
      if (p.codebase_id) {
        const cb = getCodebaseById(p.codebase_id as string);
        if (!cb) throw new RpcError("NOT_FOUND", "codebase not found");
        if (cb.project_id !== p.project_id) {
          throw new RpcError("INVALID_PARAM", "codebase does not belong to project");
        }
      }
      return await runClarifierExtract({
        raw_text: p.raw_text,
        project_id: p.project_id,
        codebase_id: (p.codebase_id as string | null | undefined) ?? null,
      });
    },
  });

  registerRpcMethod({
    method: "requirements.create",
    description: "创建需求（自动进入 clarifying 触发澄清流程）",
    handler: (params) => {
      const p = asObj(params);
      const codebaseId = (typeof p.codebase_id === "string" || p.codebase_id === null)
        ? (p.codebase_id ?? null)
        : null;
      const title = typeof p.title === "string" ? p.title.trim() : "";
      if (!title) throw new RpcError("INVALID_PARAM", "title 必填");
      let projectId = typeof p.project_id === "string" ? p.project_id.trim() : "";
      if (codebaseId) {
        const cb = getCodebaseById(codebaseId);
        if (!cb) throw new RpcError("NOT_FOUND", "codebase not found");
        if (!projectId) projectId = cb.project_id;
      }
      if (!projectId) {
        throw new RpcError("INVALID_PARAM", "project_id 必填（或提供 codebase_id 由 daemon 反查）");
      }
      const id = nextRequirementId();
      coreCreateRequirement({
        id,
        project_id: projectId,
        codebase_id: codebaseId,
        title,
        spec_md: typeof p.spec_md === "string" ? p.spec_md : "",
        chat_session_id: (p.chat_session_id as string | null | undefined) ?? null,
      });
      const clarifying = setRequirementStatus(id, "clarifying");
      return { requirement: clarifying };
    },
  });

  registerRpcMethod({
    method: "requirements.update",
    description: "更新需求字段（title / spec_md / codebase_id / clarifier_*）",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      const updated = coreUpdateRequirement(p.id, {
        title: typeof p.title === "string" ? p.title : undefined,
        spec_md: typeof p.spec_md === "string" ? p.spec_md : undefined,
        codebase_id: (p.codebase_id as string | null | undefined),
        chat_session_id: (p.chat_session_id as string | null | undefined),
        clarifier_provider: (p.clarifier_provider as string | null | undefined),
        clarifier_model: (p.clarifier_model as string | null | undefined),
      });
      if (!updated) throw new RpcError("NOT_FOUND", "requirement not found");
      return { requirement: updated };
    },
  });

  registerRpcMethod({
    method: "requirements.delete",
    description: "删除需求",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      coreDeleteRequirement(p.id);
      return { ok: true };
    },
  });

  registerRpcMethod({
    method: "requirements.transition",
    description: "手动转移状态（管理员级，绕过验证不太严格）",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      if (typeof p.to !== "string" || !p.to.trim()) throw new RpcError("INVALID_PARAM", "to 必填");
      if (!getRequirementById(p.id)) throw new RpcError("NOT_FOUND", "requirement not found");
      return { requirement: setRequirementStatus(p.id, p.to.trim()) };
    },
  });

  registerRpcMethod({
    method: "requirements.enqueue",
    description: "入队执行（必须已关联 codebase 且 spec_md 非空）",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      const r = getRequirementById(p.id);
      if (!r) throw new RpcError("NOT_FOUND", "requirement not found");
      if (!r.codebase_id) throw new RpcError("PRECONDITION_FAILED", "请先关联代码库再入队");
      if (!(r.spec_md ?? "").trim()) {
        throw new RpcError("PRECONDITION_FAILED", "需求规约为空，请先完成澄清或手动填写规约");
      }
      return { requirement: setRequirementStatus(p.id, "queued") };
    },
  });


  registerRpcMethod({
    method: "requirements.cancel",
    description: "取消需求",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      if (!getRequirementById(p.id)) throw new RpcError("NOT_FOUND", "requirement not found");
      return { requirement: setRequirementStatus(p.id, "cancelled") };
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
      // feedback 注入：若 requirement 当前 awaiting_review 自动进 fix_revision（沿用旧 inject_feedback 语义）
      if (comment.kind === "feedback" && r.status === "awaiting_review") {
        try { setRequirementStatus(reqId, "fix_revision"); } catch { /* tolerated */ }
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
    description: "保存 provider 配置 + emit config:updated",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.name !== "string" || !p.name) throw new RpcError("INVALID_PARAM", "需要 name");
      if (!(PROVIDER_NAMES as readonly string[]).includes(p.name)) {
        throw new RpcError("INVALID_PARAM", `未知 provider：${p.name}`);
      }
      // 其他字段（除 name）都是 provider config，整体保存
      const { name: _n, ...cfg } = p;
      try {
        saveProvider(p.name as ProviderName, cfg);
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

  // ── 第八批：schedules.* 域（6 个） ──

  registerRpcMethod({
    method: "schedules.list",
    description: "列出所有定时计划",
    handler: () => coreListSchedules(),
  });

  registerRpcMethod({
    method: "schedules.get",
    description: "按 id 取定时计划详情",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      const sch = coreGetSchedule(p.id);
      if (!sch) throw new RpcError("NOT_FOUND", "Schedule not found");
      return sch;
    },
  });

  registerRpcMethod({
    method: "schedules.create",
    description: "新建定时计划（once / cron）",
    handler: async (params) => {
      const p = asObj(params);
      const name = typeof p.name === "string" ? p.name.trim() : "";
      if (!name) throw new RpcError("INVALID_PARAM", "name 不能为空");
      if (p.type !== "once" && p.type !== "cron") {
        throw new RpcError("INVALID_PARAM", "type 必须是 once 或 cron");
      }
      if (typeof p.workflow !== "string" || !p.workflow.trim()) {
        throw new RpcError("INVALID_PARAM", "workflow 不能为空");
      }
      const title = typeof p.title === "string" ? p.title.trim() : "";
      if (!title) throw new RpcError("INVALID_PARAM", "title 不能为空");

      await registryDiscover();
      if (!registryGetWorkflow(p.workflow)) {
        throw new RpcError("NOT_FOUND", `workflow "${p.workflow}" 不存在`);
      }
      const timezone = (typeof p.timezone === "string" && p.timezone.trim())
        || loadDefaultsConfig().timezone
        || systemTimezone();
      if (!isValidTimezone(timezone)) {
        throw new RpcError("INVALID_PARAM", `时区无效：${timezone}`);
      }
      try {
        return coreCreateSchedule({
          name,
          type: p.type as ScheduleType,
          run_at: (p.run_at as string | null | undefined) ?? null,
          cron_expr: (p.cron_expr as string | null | undefined) ?? null,
          timezone,
          workflow: p.workflow,
          title,
          requirement: (typeof p.requirement === "string" && p.requirement.trim()) ? p.requirement.trim() : null,
          enabled: typeof p.enabled === "boolean" ? p.enabled : undefined,
        });
      } catch (e: unknown) {
        throw new RpcError("CREATE_FAILED", e instanceof Error ? e.message : String(e));
      }
    },
  });

  registerRpcMethod({
    method: "schedules.update",
    description: "PATCH 风格更新（仅传要改的字段）",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      const { id: _id, ...patch } = p;
      try {
        const sch = coreUpdateSchedule(p.id, patch);
        if (!sch) throw new RpcError("NOT_FOUND", "Schedule not found");
        return sch;
      } catch (e: unknown) {
        if (e instanceof RpcError) throw e;
        throw new RpcError("UPDATE_FAILED", e instanceof Error ? e.message : String(e));
      }
    },
  });

  registerRpcMethod({
    method: "schedules.delete",
    description: "删除定时计划",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      const ok = coreDeleteSchedule(p.id);
      if (!ok) throw new RpcError("NOT_FOUND", "Schedule not found");
      return { ok: true };
    },
  });

  registerRpcMethod({
    method: "schedules.runNow",
    description: "立即触发一次（不影响 next_run_at）",
    handler: async (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      const sch = coreGetSchedule(p.id);
      if (!sch) throw new RpcError("NOT_FOUND", "Schedule not found");
      try {
        const task = await startTaskFromTemplate({
          workflow: sch.workflow,
          title: sch.title,
          requirement: sch.requirement ?? undefined,
        });
        markScheduleFired(sch.id, task.id, sch.next_run_at, sch.enabled === 0);
        return { ok: true, taskId: task.id };
      } catch (e: unknown) {
        if (e instanceof StartTaskError) throw new RpcError("START_FAILED", e.message);
        throw new RpcError("INTERNAL", e instanceof Error ? e.message : String(e));
      }
    },
  });

  // ── 第九批：workspace + defaults + setup mutation（8 个） ──

  registerRpcMethod({
    method: "workspaces.tree",
    description: "列任务 workspace 子目录（默认根目录）",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      const relPath = typeof p.path === "string" ? p.path : "";
      try {
        return { path: relPath, entries: listWorkspaceDir(p.id, relPath) };
      } catch (e: unknown) {
        throw new RpcError("INVALID_PARAM", e instanceof Error ? e.message : String(e));
      }
    },
  });

  registerRpcMethod({
    method: "workspaces.file",
    description: "读 workspace 内单个文件（text）",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      if (typeof p.path !== "string" || !p.path) throw new RpcError("INVALID_PARAM", "需要 path");
      try {
        return readWorkspaceFile(p.id, p.path);
      } catch (e: unknown) {
        throw new RpcError("INVALID_PARAM", e instanceof Error ? e.message : String(e));
      }
    },
  });

  registerRpcMethod({
    method: "workspaces.delete",
    description: "手动清理某任务 workspace 目录",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      try {
        const removed = deleteTaskWorkspace(p.id);
        return { ok: true, removed };
      } catch (e: unknown) {
        throw new RpcError("INTERNAL", e instanceof Error ? e.message : String(e));
      }
    },
  });

  registerRpcMethod({
    method: "workspaces.usage",
    description: "扫描所有任务 workspace 占用（Dashboard 用）",
    handler: () => {
      const list = scanTaskWorkspaces();
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
      for (const [name, cfg] of Object.entries(p.providers as Record<string, unknown>)) {
        if (!(PROVIDER_NAMES as readonly string[]).includes(name)) continue;
        if (cfg && typeof cfg === "object" && !Array.isArray(cfg)) {
          saveProvider(name as ProviderName, cfg as Record<string, unknown>);
        }
      }
      return { report: await runChecks({ level: 1 }) };
    },
  });

  // setup.saveAgents 已移除（Phase 3：命名复用 agent 机制删除）。
  // setup 流程不再写命名 agent；agent 配置改为工作流 phase 内联。

  registerRpcMethod({
    method: "setup.saveCodebases",
    description: "新建 codebase（与 POST /api/setup/codebases 等价）；project_id 缺省则用首个 project 或新建 default",
    handler: (params) => {
      const p = asObj(params);
      const name = typeof p.name === "string" ? p.name.trim() : "";
      const pathField = typeof p.path === "string" ? p.path.trim() : "";
      if (!name || !pathField) throw new RpcError("INVALID_PARAM", "name and path required");
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
      const detected = detectCodebaseGit(pathField);
      const cb = createCodebase({
        id: nextCodebaseId(),
        project_id: projectId,
        alias: name,
        path: pathField,
        default_branch: detected.default_branch ?? "main",
        github_owner: detected.github_owner,
        github_repo: detected.github_repo,
      });
      return { codebase: cb };
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
    description: "级联删除 Project（含 requirements + codebases）",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      if (!getProjectById(p.id)) throw new RpcError("NOT_FOUND", "project not found");
      try {
        coreDeleteProject(p.id);
        emitBus({ type: "projects:changed", payload: { id: p.id, action: "delete" } });
        return { ok: true };
      } catch (e: unknown) {
        throw new RpcError("DELETE_FAILED", e instanceof Error ? e.message : String(e));
      }
    },
  });

  registerRpcMethod({
    method: "projects.codebases",
    description: "某 project 下的 codebase 列表",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      if (!getProjectById(p.id)) throw new RpcError("NOT_FOUND", "project not found");
      return { codebases: listCodebases({ projectId: p.id }) };
    },
  });

  registerRpcMethod({
    method: "projects.requirements",
    description: "某 project 下的需求列表",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      if (!getProjectById(p.id)) throw new RpcError("NOT_FOUND", "project not found");
      return { requirements: listRequirementsByProject(p.id) };
    },
  });

  registerRpcMethod({
    method: "projects.addCodebase",
    description: "在 project 下新建 codebase",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      const proj = getProjectById(p.id);
      if (!proj) throw new RpcError("NOT_FOUND", "project not found");
      const alias = typeof p.alias === "string" ? p.alias.trim() : "";
      const pathField = typeof p.path === "string" ? p.path.trim() : "";
      if (!alias || !pathField) throw new RpcError("INVALID_PARAM", "alias 和 path 必填");
      // 服务端兜底探测：未显式给的字段自动从 git 仓库识别（显式值优先）
      const detected = detectCodebaseGit(pathField);
      const explicitBranch = typeof p.default_branch === "string" && p.default_branch.trim()
        ? p.default_branch.trim() : null;
      let gh_owner = (p.github_owner as string | null | undefined) ?? null;
      let gh_repo = (p.github_repo as string | null | undefined) ?? null;
      if (!gh_owner && !gh_repo && detected.github_owner && detected.github_repo) {
        gh_owner = detected.github_owner;
        gh_repo = detected.github_repo;
      }
      try {
        const codebase = createCodebase({
          id: nextCodebaseId(),
          project_id: p.id,
          alias,
          path: pathField,
          default_branch: explicitBranch ?? detected.default_branch ?? "main",
          github_owner: gh_owner,
          github_repo: gh_repo,
        });
        return { codebase };
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

  // ── codebases.* —— Codebase CRUD + submodules / healthcheck ──

  registerRpcMethod({
    method: "codebases.list",
    description: "列出所有 codebase（与 GET /api/codebases 等价；返回数组，无 envelope）",
    handler: () => listCodebases(),
  });

  registerRpcMethod({
    method: "codebases.get",
    description: "按 id 取 codebase；不存在抛 NOT_FOUND",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      const cb = getCodebaseById(p.id);
      if (!cb) throw new RpcError("NOT_FOUND", "codebase not found");
      return cb;
    },
  });

  registerRpcMethod({
    method: "codebases.detect",
    description: "从本地路径探测 git 信息（默认分支 / 远程地址 / GitHub owner/repo），用于创建表单自动填充；纯读不写库",
    handler: (params) => {
      const p = asObj(params);
      const path = typeof p.path === "string" ? p.path.trim() : "";
      if (!path) throw new RpcError("INVALID_PARAM", "需要 path");
      return detectCodebaseGit(path);
    },
  });

  registerRpcMethod({
    method: "codebases.create",
    description: "创建 codebase（与 POST /api/codebases 等价）；未显式给 default_branch / github 时自动从 path 探测",
    handler: (params) => {
      const p = asObj(params);
      const alias = typeof p.alias === "string" ? p.alias.trim() : "";
      const pathField = typeof p.path === "string" ? p.path.trim() : "";
      if (!alias || !pathField) throw new RpcError("INVALID_PARAM", "alias 和 path 必填");
      const projectId = typeof p.project_id === "string" ? p.project_id.trim() : "";
      // 服务端兜底探测：CLI/Web 没传的字段自动从 git 仓库识别（显式传值优先）
      const detected = detectCodebaseGit(pathField);
      const explicitBranch = typeof p.default_branch === "string" && p.default_branch.trim()
        ? p.default_branch.trim() : null;
      let github_owner = (p.github_owner as string | null | undefined) ?? null;
      let github_repo = (p.github_repo as string | null | undefined) ?? null;
      if (!github_owner && !github_repo && detected.github_owner && detected.github_repo) {
        github_owner = detected.github_owner;
        github_repo = detected.github_repo;
      }
      try {
        const codebase = createCodebase({
          id: nextCodebaseId(),
          project_id: projectId,
          alias,
          path: pathField,
          default_branch: explicitBranch ?? detected.default_branch ?? "main",
          github_owner,
          github_repo,
        });
        return codebase;
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
    method: "codebases.update",
    description: "更新 codebase 字段（与 PUT /api/codebases/:id 等价）",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      const existing = getCodebaseById(p.id);
      if (!existing) throw new RpcError("NOT_FOUND", "codebase not found");
      const patch: Record<string, unknown> = {};
      if (p.alias !== undefined) {
        const trimmed = typeof p.alias === "string" ? p.alias.trim() : "";
        if (!trimmed) throw new RpcError("INVALID_PARAM", "alias 不能为空");
        patch.alias = trimmed;
      }
      if (p.path !== undefined) {
        const trimmed = typeof p.path === "string" ? p.path.trim() : "";
        if (!trimmed) throw new RpcError("INVALID_PARAM", "path 不能为空");
        patch.path = trimmed;
      }
      if (p.default_branch !== undefined) {
        const trimmed = typeof p.default_branch === "string" ? p.default_branch.trim() : "";
        if (trimmed) patch.default_branch = trimmed;
      }
      if (p.github_owner !== undefined) patch.github_owner = p.github_owner;
      if (p.github_repo !== undefined) patch.github_repo = p.github_repo;
      try {
        const codebase = updateCodebase(p.id, patch);
        return codebase;
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
    method: "codebases.delete",
    description: "删除 codebase；默认拒绝删有需求关联的 codebase，要求 force=true 才能级联清空 requirements.codebase_id",
    handler: async (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      const existing = getCodebaseById(p.id);
      if (!existing) throw new RpcError("NOT_FOUND", "codebase not found");
      // 默认 in_use 检查 —— 防止 web/CLI 误删带走一批需求的 codebase_id
      // 调用方必须显式 force: true 才能继续（前端弹 confirm dialog）
      if (!p.force) {
        const { getDb } = await import("../core/db");
        const row = getDb()
          .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM requirements WHERE codebase_id = ?")
          .get(p.id);
        const affected = row?.n ?? 0;
        if (affected > 0) {
          throw new RpcError(
            "IN_USE",
            `${affected} 条需求关联此 codebase；带 force=true 后会把这些 requirement.codebase_id 置 NULL（需求保留）`,
          );
        }
      }
      deleteCodebase(p.id);
      return { ok: true };
    },
  });

  registerRpcMethod({
    method: "codebases.listSubmodules",
    description: "列出 codebase 的子模块（与 GET /api/codebases/:id/submodules 等价）",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      const cb = getCodebaseById(p.id);
      if (!cb) throw new RpcError("NOT_FOUND", "codebase not found");
      return { submodules: listSubmodules(p.id) };
    },
  });

  registerRpcMethod({
    method: "codebases.healthcheck",
    description: "检查 codebase 健康状态 + 自动发现子模块（与 POST /api/codebases/:id/healthcheck 等价）",
    handler: async (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      const codebase = getCodebaseById(p.id);
      if (!codebase) throw new RpcError("NOT_FOUND", "codebase not found");
      const health = await checkCodebaseHealth(codebase.path);
      const patch: { github_owner?: string; github_repo?: string } = {};
      if (health.github_owner && !codebase.github_owner) patch.github_owner = health.github_owner;
      if (health.github_repo && !codebase.github_repo) patch.github_repo = health.github_repo;
      if (patch.github_owner !== undefined || patch.github_repo !== undefined) {
        updateCodebase(p.id, patch);
      }
      if (health.healthy && !codebase.parent_codebase_id) {
        try {
          const dr = discoverSubmodules(codebase.id);
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
    method: "codebases.rediscoverSubmodules",
    description: "重新扫描 codebase 子模块（与 POST /api/codebases/:id/rediscover-submodules 等价）",
    handler: (params) => {
      const p = asObj(params);
      if (typeof p.id !== "string" || !p.id) throw new RpcError("INVALID_PARAM", "需要 id");
      const codebase = getCodebaseById(p.id);
      if (!codebase) throw new RpcError("NOT_FOUND", "codebase not found");
      if (codebase.parent_codebase_id) {
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
