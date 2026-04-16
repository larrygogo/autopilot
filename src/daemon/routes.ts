import { existsSync } from "fs";
import { join } from "path";
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
  saveWorkflowYaml,
} from "../core/registry";
import { loadConfigRaw, saveConfigRaw } from "../core/config";
import { emit } from "./event-bus";
import type { DaemonStatus, GraphData, GraphNode, GraphEdge } from "./protocol";

// ──────────────────────────────────────────────
// Daemon 状态
// ──────────────────────────────────────────────

const startedAt = Date.now();

// ──────────────────────────────────────────────
// 辅助
// ──────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function error(message: string, status = 400): Response {
  return json({ error: message }, status);
}

function extractParam(path: string, pattern: RegExp): string | null {
  const match = path.match(pattern);
  return match?.[1] ?? null;
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

function serveStatic(path: string): Response | null {
  if (!webDistDir) return null;

  const filePath = join(webDistDir, path === "/" ? "index.html" : path);
  if (existsSync(filePath)) {
    const ext = filePath.substring(filePath.lastIndexOf("."));
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
    return new Response(Bun.file(filePath), {
      headers: { "Content-Type": contentType },
    });
  }

  // SPA fallback
  const indexPath = join(webDistDir, "index.html");
  if (existsSync(indexPath)) {
    return new Response(Bun.file(indexPath), {
      headers: { "Content-Type": "text/html" },
    });
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

  // CORS preflight
  if (method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
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

    // POST /api/reload
    if (method === "POST" && path === "/api/reload") {
      await reload();
      emit({ type: "workflow:reloaded", payload: {} });
      return json({ ok: true, workflows: listWorkflows() });
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
