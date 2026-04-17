import { existsSync } from "fs";
import { join, resolve, sep } from "path";
import { VERSION } from "../index";
import { initDb, getTask, createTask, listTasks, getTaskLogs, getSubTasks } from "../core/db";
import type { ListTasksFilters } from "../core/db";
import { transition, canTransition } from "../core/state-machine";
import { executePhase } from "../core/runner";
import {
  discover,
  reload,
  getWorkflow,
  listWorkflows,
  buildTransitions,
  getTerminalStates,
  isParallelPhase,
  getWorkflowYaml,
  getWorkflowTs,
  saveWorkflowYaml,
  createWorkflow,
  deleteWorkflowDir,
  setWorkflowPhases,
  syncWorkflowTs,
  renameRunFunctions,
  pruneOrphanRunFunctions,
  setWorkflowAgents,
  type PhaseEntryInput,
  type WorkflowAgentEntry,
} from "../core/registry";
import {
  loadConfigRaw,
  saveConfigRaw,
  loadProviders,
  saveProvider,
  loadGlobalAgents,
  saveAgent,
  deleteAgent,
  PROVIDER_NAMES,
  type ProviderName,
} from "../core/config";
import { detectProviderCli, detectAllProviders } from "../agents/cli-status";
import { listProviderModels } from "../agents/model-list";
import { runAgentOnce } from "../agents/registry";
import { emit } from "./event-bus";
import type { DaemonStatus, GraphData, GraphNode, GraphEdge } from "./protocol";

// ──────────────────────────────────────────────
// Daemon 状态
// ──────────────────────────────────────────────

const startedAt = Date.now();

// ──────────────────────────────────────────────
// CORS & 鉴权
// ──────────────────────────────────────────────

// 只允许显式 allowlist 中的 Origin 跨域访问；同源请求浏览器不发 Origin 头，
// 因此 Web UI 由 daemon 自身同源提供时不受影响。
const ALLOWED_ORIGINS = (process.env.AUTOPILOT_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// 可选 token 鉴权：设置 AUTOPILOT_API_TOKEN 后，所有 /api/* 请求需带
// `Authorization: Bearer <token>` 或 `X-Autopilot-Token: <token>`。
const API_TOKEN = process.env.AUTOPILOT_API_TOKEN ?? "";

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Vary": "Origin",
      "Access-Control-Allow-Credentials": "true",
    };
  }
  return {};
}

function checkAuth(req: Request): boolean {
  if (!API_TOKEN) return true;
  const header = req.headers.get("authorization") ?? "";
  if (header.startsWith("Bearer ") && header.slice(7) === API_TOKEN) return true;
  if (req.headers.get("x-autopilot-token") === API_TOKEN) return true;
  return false;
}

// ──────────────────────────────────────────────
// 辅助
// ──────────────────────────────────────────────

function makeResponders(req: Request) {
  const cors = corsHeaders(req);
  const json = (data: unknown, status = 200): Response =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json", ...cors },
    });
  const error = (message: string, status = 400): Response => json({ error: message }, status);
  return { json, error };
}

function extractParam(path: string, pattern: RegExp): string | null {
  const match = path.match(pattern);
  return match?.[1] ?? null;
}

/**
 * 统计每个全局 agent 被哪些工作流引用。引用条件：
 *   workflow.agents[] 中存在 name === agentName（同名继承）
 *   或 extends === agentName（别名继承）
 * 返回 { [agentName]: [workflowName, ...] }
 */
function computeAgentUsage(agentNames: string[]): Record<string, string[]> {
  const result: Record<string, string[]> = Object.fromEntries(agentNames.map((n) => [n, []]));
  const wfs = listWorkflows();
  for (const wf of wfs) {
    const full = getWorkflow(wf.name);
    const wfAgents = (full?.agents as Array<Record<string, unknown>> | undefined) ?? [];
    const refs = new Set<string>();
    for (const a of wfAgents) {
      const name = typeof a.name === "string" ? a.name : null;
      const ext = a.extends;
      if (name && agentNames.includes(name) && (ext === undefined || ext === name)) {
        refs.add(name);
      }
      if (typeof ext === "string" && agentNames.includes(ext)) {
        refs.add(ext);
      }
    }
    for (const r of refs) result[r].push(wf.name);
  }
  return result;
}

// ──────────────────────────────────────────────
// 静态文件服务
// ──────────────────────────────────────────────

let webDistDir: string | null = null;

export function setWebDistDir(dir: string): void {
  webDistDir = dir;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function serveStatic(urlPath: string): Response | null {
  if (!webDistDir) return null;
  const rootDir = resolve(webDistDir);

  let requestedFile: string | null = null;
  if (urlPath === "/" || urlPath === "") {
    requestedFile = join(rootDir, "index.html");
  } else {
    let decoded: string;
    try {
      decoded = decodeURIComponent(urlPath);
    } catch {
      return null;
    }
    // 拒绝含 NUL 字符的路径
    if (decoded.includes("\0")) return null;
    // 剥去前导 / 与 \，避免 path.join 把它当作绝对路径
    const relative = decoded.replace(/^[/\\]+/, "");
    const candidate = resolve(rootDir, relative);
    // 强制校验：最终路径必须仍位于 rootDir 之内
    if (candidate !== rootDir && !candidate.startsWith(rootDir + sep)) {
      return null;
    }
    requestedFile = candidate;
  }

  if (requestedFile && existsSync(requestedFile)) {
    const ext = requestedFile.substring(requestedFile.lastIndexOf("."));
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
    return new Response(Bun.file(requestedFile), {
      headers: { "Content-Type": contentType },
    });
  }

  // SPA fallback — 只在无明确扩展名时生效（避免对 /missing.js 返回 index.html）
  if (!/\.[a-zA-Z0-9]+$/.test(urlPath)) {
    const indexPath = join(rootDir, "index.html");
    if (existsSync(indexPath)) {
      return new Response(Bun.file(indexPath), {
        headers: { "Content-Type": "text/html" },
      });
    }
  }

  return null;
}

// ──────────────────────────────────────────────
// 路由处理
// ──────────────────────────────────────────────

export async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method;
  const path = url.pathname;
  const { json, error } = makeResponders(req);
  const cors = corsHeaders(req);

  // CORS preflight — 只为 allowlist 中的 Origin 放行
  if (method === "OPTIONS") {
    const headers: Record<string, string> = {
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Autopilot-Token",
      "Access-Control-Max-Age": "600",
      ...cors,
    };
    return new Response(null, { status: 204, headers });
  }

  // Token 鉴权（仅在 /api/* 上生效，静态资源不需要）
  if (path.startsWith("/api/") && !checkAuth(req)) {
    return error("Unauthorized", 401);
  }

  try {
    // ── API Routes ──

    // GET /api/status
    if (method === "GET" && path === "/api/status") {
      const tasks = listTasks();
      const taskCounts: Record<string, number> = {};
      for (const t of tasks) {
        taskCounts[t.status] = (taskCounts[t.status] ?? 0) + 1;
      }
      const status: DaemonStatus = {
        version: VERSION,
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        pid: process.pid,
        taskCounts,
      };
      return json(status);
    }

    // GET /api/tasks
    if (method === "GET" && path === "/api/tasks") {
      const filters: ListTasksFilters = {};
      const status = url.searchParams.get("status");
      const workflow = url.searchParams.get("workflow");
      const limit = url.searchParams.get("limit");
      if (status) filters.status = status;
      if (workflow) filters.workflow = workflow;
      if (limit) filters.limit = parseInt(limit, 10);
      return json(listTasks(filters));
    }

    // POST /api/tasks
    if (method === "POST" && path === "/api/tasks") {
      const body = await req.json() as { reqId: string; title?: string; workflow?: string };
      if (!body.reqId) return error("reqId is required");

      await discover();
      const workflows = listWorkflows();
      if (workflows.length === 0) return error("No workflows found", 500);

      let workflowName: string;
      if (body.workflow) {
        workflowName = body.workflow;
      } else if (workflows.length === 1) {
        workflowName = workflows[0].name;
      } else {
        return error(`Multiple workflows found, specify one: ${workflows.map((w) => w.name).join(", ")}`);
      }

      const wf = getWorkflow(workflowName);
      if (!wf) return error(`Workflow "${workflowName}" not found`);

      const taskId = body.reqId.slice(0, 8);
      const title = body.title ?? body.reqId;

      let extra: Record<string, unknown> = {};
      if (typeof wf.setup_func === "function") {
        try {
          extra = wf.setup_func({ reqId: body.reqId, title, taskId }) ?? {};
        } catch (e: unknown) {
          return error(`setup_func failed: ${e instanceof Error ? e.message : String(e)}`, 500);
        }
      }

      const firstPhaseEntry = wf.phases[0];
      if (!firstPhaseEntry) return error("Workflow has no phases", 500);
      const firstPhaseName = isParallelPhase(firstPhaseEntry)
        ? firstPhaseEntry.parallel.name
        : firstPhaseEntry.name;

      createTask({
        id: taskId,
        title,
        workflow: workflowName,
        initialStatus: wf.initial_state,
        extra,
      });

      // 异步执行第一阶段
      executePhase(taskId, firstPhaseName).catch(() => {});

      const task = getTask(taskId);
      return json(task, 201);
    }

    // GET /api/tasks/:id
    const taskIdMatch = extractParam(path, /^\/api\/tasks\/([\w.\-]+)$/);
    if (method === "GET" && taskIdMatch) {
      const task = getTask(taskIdMatch);
      if (!task) return error("Task not found", 404);
      return json(task);
    }

    // POST /api/tasks/:id/cancel
    const cancelMatch = extractParam(path, /^\/api\/tasks\/([\w.\-]+)\/cancel$/);
    if (method === "POST" && cancelMatch) {
      const task = getTask(cancelMatch);
      if (!task) return error("Task not found", 404);

      const wf = getWorkflow(task.workflow);
      const terminalStates = new Set(["done", "cancelled"]);
      if (wf) for (const s of wf.terminal_states ?? []) terminalStates.add(s);
      if (terminalStates.has(task.status)) return error(`Task already in terminal state: ${task.status}`);

      const transitions = wf
        ? buildTransitions(wf)
        : { [task.status]: [["cancel", "cancelled"] as [string, string]] };

      const [from, to] = transition(cancelMatch, "cancel", { transitions, note: "API cancel" });
      return json({ from, to });
    }

    // POST /api/tasks/:id/transition
    const transitionMatch = extractParam(path, /^\/api\/tasks\/([\w.\-]+)\/transition$/);
    if (method === "POST" && transitionMatch) {
      const body = await req.json() as { trigger: string; note?: string };
      if (!body.trigger) return error("trigger is required");

      const task = getTask(transitionMatch);
      if (!task) return error("Task not found", 404);

      const wf = getWorkflow(task.workflow);
      if (!wf) return error("Workflow not found", 500);

      const transitions = buildTransitions(wf);
      const [from, to] = transition(transitionMatch, body.trigger, { transitions, note: body.note });
      return json({ from, to });
    }

    // GET /api/tasks/:id/logs
    const logsMatch = extractParam(path, /^\/api\/tasks\/([\w.\-]+)\/logs$/);
    if (method === "GET" && logsMatch) {
      const limit = parseInt(url.searchParams.get("limit") ?? "100", 10);
      return json(getTaskLogs(logsMatch, limit));
    }

    // GET /api/tasks/:id/subtasks
    const subtasksMatch = extractParam(path, /^\/api\/tasks\/([\w.\-]+)\/subtasks$/);
    if (method === "GET" && subtasksMatch) {
      return json(getSubTasks(subtasksMatch));
    }

    // GET /api/workflows
    if (method === "GET" && path === "/api/workflows") {
      return json(listWorkflows());
    }

    // POST /api/workflows — 创建工作流脚手架
    if (method === "POST" && path === "/api/workflows") {
      const body = await req.json() as { name?: string; description?: string; firstPhase?: string };
      if (typeof body.name !== "string" || !body.name) return error("name is required");
      try {
        const result = createWorkflow({
          name: body.name,
          description: body.description,
          firstPhase: body.firstPhase,
        });
        await reload();
        emit({ type: "workflow:reloaded", payload: {} });
        return json({ ok: true, name: body.name, dir: result.dir }, 201);
      } catch (e: unknown) {
        return error(`创建失败：${e instanceof Error ? e.message : String(e)}`, 400);
      }
    }

    // DELETE /api/workflows/:name — 删除工作流目录
    const wfDeleteMatch = extractParam(path, /^\/api\/workflows\/([\w.\-]+)$/);
    if (method === "DELETE" && wfDeleteMatch) {
      try {
        const ok = deleteWorkflowDir(wfDeleteMatch);
        if (!ok) return error("Workflow not found", 404);
        await reload();
        emit({ type: "workflow:reloaded", payload: {} });
        return json({ ok: true });
      } catch (e: unknown) {
        return error(`删除失败：${e instanceof Error ? e.message : String(e)}`, 400);
      }
    }

    // GET /api/workflows/:name
    const wfMatch = extractParam(path, /^\/api\/workflows\/([\w.\-]+)$/);
    if (method === "GET" && wfMatch) {
      const wf = getWorkflow(wfMatch);
      if (!wf) return error("Workflow not found", 404);
      // 返回安全的序列化版本（排除函数）
      const { setup_func, notify_func, ...safe } = wf;
      const safePhasesArr = safe.phases.map((p: any) => {
        if ("parallel" in p) {
          return {
            parallel: {
              ...p.parallel,
              phases: p.parallel.phases.map((sub: any) => {
                const { func, ...rest } = sub;
                return rest;
              }),
            },
          };
        }
        const { func, ...rest } = p;
        return rest;
      });
      return json({ ...safe, phases: safePhasesArr });
    }

    // GET /api/workflows/:name/graph
    const graphMatch = extractParam(path, /^\/api\/workflows\/([\w.\-]+)\/graph$/);
    if (method === "GET" && graphMatch) {
      const wf = getWorkflow(graphMatch);
      if (!wf) return error("Workflow not found", 404);

      const transitions = buildTransitions(wf);
      const terminalStates = getTerminalStates(graphMatch);
      const nodes = new Map<string, GraphNode>();
      const edges: GraphEdge[] = [];

      // 添加初始状态节点
      nodes.set(wf.initial_state, {
        id: wf.initial_state,
        label: wf.initial_state,
        type: "initial",
      });

      // 从转换表构建图
      for (const [fromState, trans] of Object.entries(transitions)) {
        if (!nodes.has(fromState)) {
          nodes.set(fromState, {
            id: fromState,
            label: fromState,
            type: fromState.startsWith("running_") ? "running"
              : fromState.startsWith("pending_") ? "pending"
              : terminalStates.includes(fromState) ? "terminal"
              : "other",
          });
        }
        for (const [trigger, toState] of trans) {
          if (!nodes.has(toState)) {
            nodes.set(toState, {
              id: toState,
              label: toState,
              type: toState.startsWith("running_") ? "running"
                : toState.startsWith("pending_") ? "pending"
                : terminalStates.includes(toState) ? "terminal"
                : "other",
            });
          }
          edges.push({ from: fromState, to: toState, trigger });
        }
      }

      const graphData: GraphData = {
        nodes: [...nodes.values()],
        edges,
        initialState: wf.initial_state,
        terminalStates,
      };
      return json(graphData);
    }

    // ── Config API ──

    // GET /api/config
    if (method === "GET" && path === "/api/config") {
      return json({ yaml: loadConfigRaw() });
    }

    // PUT /api/config
    if (method === "PUT" && path === "/api/config") {
      const body = await req.json() as { yaml: string };
      if (typeof body.yaml !== "string") return error("yaml field is required");
      try {
        saveConfigRaw(body.yaml);
        emit({ type: "config:updated", payload: {} });
        return json({ ok: true });
      } catch (e: unknown) {
        return error(`Invalid YAML: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // GET /api/workflows/:name/yaml
    const yamlReadMatch = extractParam(path, /^\/api\/workflows\/([\w.\-]+)\/yaml$/);
    if (method === "GET" && yamlReadMatch) {
      const yaml = getWorkflowYaml(yamlReadMatch);
      if (yaml === null) return error("Workflow not found", 404);
      return json({ yaml });
    }

    // GET /api/workflows/:name/ts — 读 workflow.ts 源码
    const tsReadMatch = extractParam(path, /^\/api\/workflows\/([\w.\-]+)\/ts$/);
    if (method === "GET" && tsReadMatch) {
      const content = getWorkflowTs(tsReadMatch);
      if (content === null) return error("workflow.ts not found", 404);
      return json({ content });
    }

    // PUT /api/workflows/:name/yaml
    const yamlWriteMatch = extractParam(path, /^\/api\/workflows\/([\w.\-]+)\/yaml$/);
    if (method === "PUT" && yamlWriteMatch) {
      const body = await req.json() as { yaml: string };
      if (typeof body.yaml !== "string") return error("yaml field is required");
      try {
        saveWorkflowYaml(yamlWriteMatch, body.yaml);
        await reload();
        emit({ type: "workflow:reloaded", payload: {} });
        return json({ ok: true });
      } catch (e: unknown) {
        return error(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // PUT /api/workflows/:name/phases — 结构化更新 phases 段
    const phasesWriteMatch = extractParam(path, /^\/api\/workflows\/([\w.\-]+)\/phases$/);
    if (method === "PUT" && phasesWriteMatch) {
      const body = await req.json() as {
        phases: unknown;
        sync_ts?: boolean;
        renames?: Record<string, string>;
      };
      if (!Array.isArray(body.phases)) return error("phases must be array", 400);
      try {
        // 1. 先重命名 run_ 函数（保留函数体），避免产生孤儿
        let renamedFns: string[] = [];
        if (body.renames && typeof body.renames === "object") {
          const r = renameRunFunctions(phasesWriteMatch, body.renames);
          renamedFns = r.renamed;
        }
        // 2. 写入 phases
        setWorkflowPhases(phasesWriteMatch, body.phases as PhaseEntryInput[]);
        await reload();
        let tsResult: { added: string[]; orphans: string[]; modified: boolean; legacy_signature?: string[] } | null = null;
        let tsError: string | null = null;
        if (body.sync_ts !== false) {
          try {
            tsResult = syncWorkflowTs(phasesWriteMatch);
            if (tsResult.modified) await reload();
          } catch (e: unknown) {
            tsError = e instanceof Error ? e.message : String(e);
            tsResult = { added: [], orphans: [], modified: false };
          }
        }
        emit({ type: "workflow:reloaded", payload: {} });
        return json({ ok: true, ts: tsResult, ts_error: tsError, renamed: renamedFns });
      } catch (e: unknown) {
        return error(`保存失败：${e instanceof Error ? e.message : String(e)}`, 400);
      }
    }

    // PUT /api/workflows/:name/agents — 结构化更新 agents 段
    const wfAgentsMatch = extractParam(path, /^\/api\/workflows\/([\w.\-]+)\/agents$/);
    if (method === "PUT" && wfAgentsMatch) {
      const body = await req.json() as { agents: unknown };
      if (!Array.isArray(body.agents)) return error("agents must be array", 400);
      try {
        setWorkflowAgents(wfAgentsMatch, body.agents as WorkflowAgentEntry[]);
        await reload();
        emit({ type: "workflow:reloaded", payload: {} });
        return json({ ok: true });
      } catch (e: unknown) {
        return error(`保存失败：${e instanceof Error ? e.message : String(e)}`, 400);
      }
    }

    // POST /api/workflows/:name/prune-orphans — 删除指定的孤儿 run_ 函数
    const pruneMatch = extractParam(path, /^\/api\/workflows\/([\w.\-]+)\/prune-orphans$/);
    if (method === "POST" && pruneMatch) {
      const body = await req.json() as { names?: string[] };
      if (!Array.isArray(body.names)) return error("names must be array", 400);
      try {
        const result = pruneOrphanRunFunctions(pruneMatch, body.names);
        if (result.removed.length > 0) {
          await reload();
          emit({ type: "workflow:reloaded", payload: {} });
        }
        return json(result);
      } catch (e: unknown) {
        return error(`清理失败：${e instanceof Error ? e.message : String(e)}`, 400);
      }
    }

    // POST /api/workflows/:name/sync-ts — 校准 workflow.ts
    const syncTsMatch = extractParam(path, /^\/api\/workflows\/([\w.\-]+)\/sync-ts$/);
    if (method === "POST" && syncTsMatch) {
      try {
        const result = syncWorkflowTs(syncTsMatch);
        if (result.modified) {
          await reload();
          emit({ type: "workflow:reloaded", payload: {} });
        }
        return json(result);
      } catch (e: unknown) {
        return error(`校准失败：${e instanceof Error ? e.message : String(e)}`, 400);
      }
    }

    // POST /api/reload
    if (method === "POST" && path === "/api/reload") {
      await reload();
      emit({ type: "workflow:reloaded", payload: {} });
      return json({ ok: true, workflows: listWorkflows() });
    }

    // ── Providers API ──

    // GET /api/providers — 返回三个内置 provider 的当前配置 + agent_count
    if (method === "GET" && path === "/api/providers") {
      const providers = loadProviders();
      const agents = loadGlobalAgents();
      const counts: Record<string, number> = {};
      for (const cfg of Object.values(agents)) {
        const p = (cfg as Record<string, unknown>)["provider"];
        if (typeof p === "string") counts[p] = (counts[p] ?? 0) + 1;
      }
      return json(
        PROVIDER_NAMES.map((name) => ({
          name,
          ...providers[name],
          agent_count: counts[name] ?? 0,
        }))
      );
    }

    // GET /api/providers/status — 全部三家 CLI 健康检查
    if (method === "GET" && path === "/api/providers/status") {
      const all = await detectAllProviders();
      return json(Object.values(all));
    }

    // GET /api/providers/:name/status — 单独检测某家
    const providerStatusMatch = extractParam(path, /^\/api\/providers\/([\w\-]+)\/status$/);
    if (method === "GET" && providerStatusMatch) {
      if (!(PROVIDER_NAMES as readonly string[]).includes(providerStatusMatch)) {
        return error(`未知 provider：${providerStatusMatch}`, 400);
      }
      const status = await detectProviderCli(providerStatusMatch as ProviderName);
      return json(status);
    }

    // GET /api/providers/:name/models — 列表（API 或 catalog）
    const providerModelsMatch = extractParam(path, /^\/api\/providers\/([\w\-]+)\/models$/);
    if (method === "GET" && providerModelsMatch) {
      if (!(PROVIDER_NAMES as readonly string[]).includes(providerModelsMatch)) {
        return error(`未知 provider：${providerModelsMatch}`, 400);
      }
      const result = await listProviderModels(providerModelsMatch as ProviderName);
      return json(result);
    }

    // PUT /api/providers/:name
    const providerMatch = extractParam(path, /^\/api\/providers\/([\w\-]+)$/);
    if (method === "PUT" && providerMatch) {
      if (!(PROVIDER_NAMES as readonly string[]).includes(providerMatch)) {
        return error(`未知 provider：${providerMatch}`, 400);
      }
      const body = await req.json() as Record<string, unknown>;
      try {
        saveProvider(providerMatch as ProviderName, body);
        emit({ type: "config:updated", payload: {} });
        return json({ ok: true });
      } catch (e: unknown) {
        return error(`保存失败：${e instanceof Error ? e.message : String(e)}`, 500);
      }
    }

    // ── Agents API ──

    // GET /api/agents — 返回全局 agents 列表（含 used_by 工作流）
    if (method === "GET" && path === "/api/agents") {
      const agents = loadGlobalAgents();
      const usage = computeAgentUsage(Object.keys(agents));
      return json(
        Object.entries(agents).map(([name, cfg]) => ({
          name,
          ...cfg,
          used_by: usage[name] ?? [],
        }))
      );
    }

    // GET /api/agents/:name
    const agentReadMatch = extractParam(path, /^\/api\/agents\/([\w.\-]+)$/);
    if (method === "GET" && agentReadMatch) {
      const agents = loadGlobalAgents();
      const cfg = agents[agentReadMatch];
      if (!cfg) return error("Agent not found", 404);
      return json({ name: agentReadMatch, ...cfg });
    }

    // POST /api/agents — 新建（name 在 body 中）
    if (method === "POST" && path === "/api/agents") {
      const body = await req.json() as Record<string, unknown> & { name?: string };
      const name = body.name;
      if (typeof name !== "string" || !name) return error("name is required");
      const agents = loadGlobalAgents();
      if (agents[name]) return error(`Agent "${name}" 已存在，请用 PUT 更新`, 409);
      try {
        const { name: _, ...rest } = body;
        saveAgent(name, rest);
        emit({ type: "config:updated", payload: {} });
        return json({ ok: true, name }, 201);
      } catch (e: unknown) {
        return error(`创建失败：${e instanceof Error ? e.message : String(e)}`, 400);
      }
    }

    // PUT /api/agents/:name
    if (method === "PUT" && agentReadMatch) {
      const body = await req.json() as Record<string, unknown>;
      try {
        const { name: _, ...rest } = body;
        saveAgent(agentReadMatch, rest);
        emit({ type: "config:updated", payload: {} });
        return json({ ok: true });
      } catch (e: unknown) {
        return error(`保存失败：${e instanceof Error ? e.message : String(e)}`, 400);
      }
    }

    // DELETE /api/agents/:name
    if (method === "DELETE" && agentReadMatch) {
      const removed = deleteAgent(agentReadMatch);
      if (!removed) return error("Agent not found", 404);
      emit({ type: "config:updated", payload: {} });
      return json({ ok: true });
    }

    // POST /api/agents/:name/dry-run — 一次性调用，用于 UI 调试
    const agentDryRunMatch = extractParam(path, /^\/api\/agents\/([\w.\-]+)\/dry-run$/);
    if (method === "POST" && agentDryRunMatch) {
      const body = await req.json() as {
        prompt?: string;
        system_prompt?: string;
        additional_system?: string;
        model?: string;
        max_turns?: number;
      };
      if (typeof body.prompt !== "string" || !body.prompt.trim()) {
        return error("prompt 不能为空", 400);
      }
      try {
        const started = Date.now();
        const result = await runAgentOnce(agentDryRunMatch, body.prompt, {
          system_prompt: body.system_prompt,
          additional_system: body.additional_system,
          model: body.model,
          max_turns: body.max_turns,
        });
        const elapsed_ms = Date.now() - started;
        return json({ ok: true, elapsed_ms, result });
      } catch (e: unknown) {
        return error(`试跑失败：${e instanceof Error ? e.message : String(e)}`, 500);
      }
    }

    // ── Static files ──
    if (method === "GET" && !path.startsWith("/api/")) {
      const staticResponse = serveStatic(path);
      if (staticResponse) return staticResponse;
    }

    return error("Not Found", 404);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return error(message, 500);
  }
}
