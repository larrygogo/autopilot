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
import { listWorkflows } from "../core/registry";
import { listProjects } from "../core/projects";
import { loadProviders, loadGlobalAgents, loadConfigRaw, PROVIDER_NAMES } from "../core/config";
import { detectAllProviders } from "../agents/cli-status";
import { runChecks } from "../core/doctor";
import {
  listPhaseLogs,
  readPhaseLog,
  readTaskEvents,
  listAgentCalls,
  getAgentCall,
} from "../core/task-logs";
import { getNowAggregator } from "./routes-now";
import { computeAgentUsage } from "./routes";
import { computeTaskOutcome } from "./task-outcome";
import {
  cancelTaskAction,
  restartTaskAction,
  answerTaskAction,
  TaskActionError,
} from "./task-actions";
import { startTaskFromTemplate, StartTaskError } from "../core/task-factory";
import { cascadeDeleteTask, DeleteTaskError } from "../core/task-delete";
import { registerRpcMethod, RpcError } from "./rpc";
import { VERSION } from "../index";

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

let registered = false;

/** 在 daemon 启动早期调用一次。重复调用幂等。 */
export function registerCoreRpcMethods(): void {
  if (registered) return;
  registered = true;

  registerRpcMethod({
    method: "daemon.status",
    description: "返回 daemon version / pid / uptime / 各状态任务数",
    handler: () => ({
      version: VERSION,
      pid: process.pid,
      uptime: Math.floor(process.uptime()),
      // taskCounts 由 daemon 启动时维护；此处直接现算一次（小数据量 OK）
      taskCounts: countTasksByStatus(),
    }),
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
    description: "列出已注册的工作流",
    handler: () => listWorkflows(),
  });

  registerRpcMethod({
    method: "projects.list",
    description: "列出所有 Project",
    handler: () => listProjects(),
  });

  // ── 第二批 PoC（高频查询类） ──

  registerRpcMethod({
    method: "providers.list",
    description: "返回三个内置 provider 的配置 + 各 provider 的 agent 引用计数",
    handler: () => {
      const providers = loadProviders();
      const agents = loadGlobalAgents();
      const counts: Record<string, number> = {};
      for (const cfg of Object.values(agents)) {
        const p = (cfg as Record<string, unknown>)["provider"];
        if (typeof p === "string") counts[p] = (counts[p] ?? 0) + 1;
      }
      return PROVIDER_NAMES.map((name) => ({
        name,
        ...providers[name],
        agent_count: counts[name] ?? 0,
      }));
    },
  });

  registerRpcMethod({
    method: "providers.statusAll",
    description: "三家 CLI 健康检查（并行 detect）",
    handler: async () => Object.values(await detectAllProviders()),
  });

  registerRpcMethod({
    method: "agents.list",
    description: "全局 agents 列表 + 各 agent 被哪些工作流引用",
    handler: () => {
      const agents = loadGlobalAgents();
      const usage = computeAgentUsage(Object.keys(agents));
      return Object.entries(agents).map(([name, cfg]) => ({
        name,
        ...cfg,
        used_by: usage[name] ?? [],
      }));
    },
  });

  registerRpcMethod({
    method: "now.cards",
    description: "Now 页卡片列表（daemon 未启动时返回空数组）",
    handler: () => {
      const agg = getNowAggregator();
      return agg ? agg.getCards() : [];
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

function countTasksByStatus(): Record<string, number> {
  const all = listTasks({});
  const out: Record<string, number> = {};
  for (const t of all) {
    const s = (t as { status: string }).status;
    out[s] = (out[s] ?? 0) + 1;
  }
  return out;
}
