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

import { listTasks, getTask, getKv } from "../core/db";
import { listWorkflows } from "../core/registry";
import { listProjects } from "../core/projects";
import { loadProviders, loadGlobalAgents, loadConfigRaw, PROVIDER_NAMES } from "../core/config";
import { detectAllProviders } from "../agents/cli-status";
import { runChecks } from "../core/doctor";
import { getNowAggregator } from "./routes-now";
import { computeAgentUsage } from "./routes";
import { registerRpcMethod, RpcError } from "./rpc";
import { VERSION } from "../index";

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
