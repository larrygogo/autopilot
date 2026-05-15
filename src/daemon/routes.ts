import { existsSync, mkdirSync, writeFileSync, appendFileSync } from "fs";
import { readdir } from "node:fs/promises";
import { join, resolve, sep, dirname, parse as parsePath } from "path";
import { getPhaseIndex } from "../core/artifacts";
import { VERSION } from "../index";
import { initDb, getDb, getTask, createTask, listTasks, getTaskLogs, getSubTasks, updateTask } from "../core/db";
import { log } from "../core/logger";
import { snapshotWorkflow } from "../core/manifest";
import {
  createSession,
  appendMessage,
  readManifest as readSessionManifest,
  readMessages as readSessionMessages,
  updateManifest as updateSessionManifest,
  listSessions as listChatSessions,
  deleteSession as deleteChatSession,
  type ChatMessage,
} from "../core/sessions";
import { resolveChatAgentName, createChatAgent } from "../agents/registry";
import type { ListTasksFilters } from "../core/db";
import { transition, canTransition } from "../core/state-machine";
import { executePhase } from "../core/runner";
import { startTaskFromTemplate, StartTaskError } from "../core/task-factory";
import { cascadeDeleteTask, DeleteTaskError } from "../core/task-delete";
import { cancelTaskAction, restartTaskAction, answerTaskAction, TaskActionError } from "./task-actions";
import {
  createSchedule,
  getSchedule,
  listSchedules,
  updateSchedule,
  deleteSchedule,
  markScheduleFired,
  computeNextRun,
  systemTimezone,
  isValidTimezone,
  type ScheduleType,
} from "../core/schedules";
import {
  listCodebases,
  getCodebaseById,
  createCodebase,
  updateCodebase,
  deleteCodebase,
  nextCodebaseId,
} from "../core/codebases";
import { listProjects, getProjectById, createProject, updateProject, deleteProject, nextProjectId } from "../core/projects";
import { checkCodebaseHealth } from "../core/codebase-health";
import { discoverSubmodules, listSubmodules } from "../core/submodules";
import { listSubPrs } from "../core/requirement-sub-prs";
import {
  listRequirements,
  listRequirementsByProject,
  getRequirementById,
  createRequirement,
  updateRequirement,
  setRequirementStatus,
  nextRequirementId,
  deleteRequirement,
  finishClarification,
} from "../core/requirements";
import { listQuestionsByRequirement, createQuestion, getQuestionById, addReply, resolveQuestion, nextQuestionId, nextReplyId } from "../core/requirement-questions";
import type { Requirement } from "../core/requirements";
import { listSpecRevisionsByRequirement } from "../core/spec-revisions";
import { runClarifierRound } from "./requirement-clarifier";
import { getRound } from "./clarifier-progress";
import { handleMcpHttp } from "../agents/mcp-server";
import { getMcpToken } from "./mcp-runtime";
import { buildAutopilotTools, buildWorkflowAgentTools } from "../agents/tools";
import type { RegisteredTool } from "../agents/mcp-tools";

/**
 * 向后兼容别名：T14 把 Requirement.repo_id 改名为 codebase_id 后，
 * web UI 与既有外部脚本仍可能引用 repo_id。daemon 在序列化时把 codebase_id 同步映射到 repo_id 字段，
 * 直到调用方都升级（P4 / P5 后可移除）。
 */
function withRepoIdAlias<T extends Requirement | null>(req: T): T extends null ? null : Requirement & { repo_id: string | null };
function withRepoIdAlias(req: Requirement | null): (Requirement & { repo_id: string | null }) | null {
  if (!req) return null;
  return { ...req, repo_id: req.codebase_id };
}
import { appendFeedback, listFeedbacks } from "../core/requirement-feedbacks";
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
  replaceRunFunction,
  setWorkflowAgents,
  type PhaseEntryInput,
  type WorkflowAgentEntry,
} from "../core/registry";
import {
  listWorkflowsInDb,
  getWorkflowFromDb,
  updateDbWorkflow,
  deleteDbWorkflow,
} from "../core/workflows";
import {
  loadConfigRaw,
  saveConfigRaw,
  loadDefaultsConfig,
  saveDefaultsConfig,
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
import {
  ensureTaskWorkspace,
  getTaskWorkspace,
  listWorkspaceDir,
  readWorkspaceFile,
  resolveWorkspacePath,
  spawnWorkspaceZip,
  deleteTaskWorkspace,
  scanTaskWorkspaces,
  workspaceSize,
} from "../core/workspace";
import { listPhaseLogs, readPhaseLog, readTaskEvents, listAgentCalls, getAgentCall } from "../core/task-logs";
import { readDaemonFileLog, getDaemonFileLogPath } from "../core/logger";
import { emit } from "../core/event-bus";
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

/**
 * 拉取所有 MCP 工具：autopilot 工具集 + workflow agent 工具集合并返回。
 * 每次 MCP tools/list 或 tools/call 都调一次（构建很轻量，全是同步 DB 读）。
 *
 * 注：客户端调用名要带 `mcp__autopilot__` 前缀（如 `mcp__autopilot__list_tasks`），
 * 前缀由 claude 根据 mcp-config 里的服务器名（"autopilot"）自动拼接，server 这边只暴露裸名字。
 */
async function getAllMcpTools(): Promise<RegisteredTool[]> {
  const [autopilotTools, workflowTools] = await Promise.all([
    buildAutopilotTools(),
    buildWorkflowAgentTools(),
  ]);
  return [...autopilotTools, ...workflowTools];
}

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
export function computeAgentUsage(agentNames: string[]): Record<string, string[]> {
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
// gate 决断辅助
// ──────────────────────────────────────────────

function phaseIndex(wf: ReturnType<typeof getWorkflow>, phase: string): number {
  if (!wf) return -1;
  return getPhaseIndex(wf, phase);
}

function parseDecisionCounts(raw: unknown): Record<string, number> {
  if (typeof raw !== "string") return {};
  try {
    return JSON.parse(raw) as Record<string, number>;
  } catch {
    return {};
  }
}

function renderDecisionMd(d: { phase: string; decision: string; note: string; ts: string; by: string }): string {
  return [
    `# 决断 · ${d.ts}`,
    "",
    `- 阶段：\`${d.phase}\``,
    `- 决断：**${d.decision}**`,
    `- 提交者：${d.by}`,
    "",
    "## 备注",
    "",
    d.note || "_（无）_",
    "",
  ].join("\n");
}

// ──────────────────────────────────────────────
// Task ID 生成
// ──────────────────────────────────────────────

// 字母表去掉容易混淆的字符（0/1/o/i/l）以及 4（团队偏好）
// task id 生成与任务启动逻辑已迁到 src/core/task-factory.ts

// ──────────────────────────────────────────────
// 静态文件服务
// ──────────────────────────────────────────────

let webDistDir: string | null = null;

export function setWebDistDir(dir: string): void {
  webDistDir = dir;
}

// daemon 启动时注入 listen host，供 /api/fs/list 等做来源校验
let CURRENT_LISTEN_HOST: string | null = null;

export function setListenHost(host: string): void {
  CURRENT_LISTEN_HOST = host;
}

export function getListenHost(): string | null {
  return CURRENT_LISTEN_HOST;
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

  // MCP HTTP server：claude CLI 通过 --mcp-config 连入，走自己的 Bearer 鉴权，
  // 不复用 /api/* 的 AUTOPILOT_API_TOKEN，也不需要 CORS（来源是本机 claude 子进程）。
  if (path === "/mcp") {
    const token = getMcpToken();
    // 防御深度：daemon 启动顺序已把 initMcpRuntime 提前到 server 之前，
    // 但万一未来重构破坏顺序，这里也得拒绝请求 —— mcp-server.checkAuth 把空
    // token 当成"不鉴权"，绝不能把 null token 透传过去。
    if (!token) return error("MCP runtime not initialized", 503);
    return handleMcpHttp(req, {
      token,
      getTools: getAllMcpTools,
      serverName: "autopilot",
      serverVersion: VERSION,
    });
  }

  // Token 鉴权（仅在 /api/* 上生效，静态资源不需要）
  if (path.startsWith("/api/") && !checkAuth(req)) {
    return error("Unauthorized", 401);
  }

  try {
    // ── /now 路由（PR 1：状态推导引擎）──
    if (path.startsWith("/api/now/")) {
      const { handleNowRequest } = await import("./routes-now");
      const nowRes = await handleNowRequest(req, url);
      if (nowRes) {
        const headers = new Headers(nowRes.headers);
        for (const [k, v] of Object.entries(cors)) headers.set(k, v);
        return new Response(nowRes.body, { status: nowRes.status, headers });
      }
    }

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

    // GET /api/daemon/log?tail=N
    if (method === "GET" && path === "/api/daemon/log") {
      const tailParam = url.searchParams.get("tail");
      const tail = tailParam ? parseInt(tailParam, 10) : 500;
      return json({
        path: getDaemonFileLogPath() ?? null,
        content: readDaemonFileLog(tail),
      });
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
      const body = (await req.json()) as {
        title?: string;
        requirement?: string;
        workflow?: string;
        reqId?: string;
        /** CLI 传入仓库别名，daemon 解析为 repo_id 透传给 setup_func */
        repo_alias?: string;
        /** 额外工作流参数（如 repo_id），透传给 setup_func */
        [key: string]: unknown;
      };
      // 如果 caller 传了 repo_alias，解析为 repo_id（不覆盖已有 repo_id）
      // P3 待修：alias 现在 project 内唯一，全局可能多个；目前取首个匹配。
      if (body.repo_alias && !body.repo_id) {
        const repo = listCodebases({ includeSubmodules: true }).find(
          (c) => c.alias === body.repo_alias,
        );
        if (!repo) return error(`找不到别名为 "${body.repo_alias}" 的仓库`, 404);
        body.repo_id = repo.id;
      }
      try {
        const task = await startTaskFromTemplate(body);
        return json(task, 201);
      } catch (e: unknown) {
        if (e instanceof StartTaskError) return error(e.message, e.status);
        return error(e instanceof Error ? e.message : String(e), 500);
      }
    }

    // ─────────── Schedules ───────────

    // GET /api/schedules
    if (method === "GET" && path === "/api/schedules") {
      return json(listSchedules());
    }

    // POST /api/schedules
    if (method === "POST" && path === "/api/schedules") {
      const body = (await req.json()) as {
        name?: string;
        type?: ScheduleType;
        run_at?: string | null;
        cron_expr?: string | null;
        timezone?: string;
        workflow?: string;
        title?: string;
        requirement?: string | null;
        enabled?: boolean;
      };
      if (!body.name?.trim()) return error("name 不能为空");
      if (body.type !== "once" && body.type !== "cron") {
        return error("type 必须是 once 或 cron");
      }
      if (!body.workflow?.trim()) return error("workflow 不能为空");
      if (!body.title?.trim()) return error("title 不能为空");

      // 校验 workflow 存在
      await discover();
      if (!getWorkflow(body.workflow)) {
        return error(`workflow "${body.workflow}" 不存在`);
      }

      const timezone =
        body.timezone?.trim() || loadDefaultsConfig().timezone || systemTimezone();
      if (!isValidTimezone(timezone)) {
        return error(`时区无效：${timezone}`);
      }
      try {
        const sch = createSchedule({
          name: body.name.trim(),
          type: body.type,
          run_at: body.run_at ?? null,
          cron_expr: body.cron_expr ?? null,
          timezone,
          workflow: body.workflow,
          title: body.title.trim(),
          requirement: body.requirement?.trim() || null,
          enabled: body.enabled,
        });
        return json(sch, 201);
      } catch (e: unknown) {
        return error(e instanceof Error ? e.message : String(e));
      }
    }

    // GET /api/schedules/:id
    const scheduleIdMatch = extractParam(path, /^\/api\/schedules\/([\w.\-]+)$/);
    if (method === "GET" && scheduleIdMatch) {
      const sch = getSchedule(scheduleIdMatch);
      if (!sch) return error("Schedule not found", 404);
      return json(sch);
    }

    // PATCH /api/schedules/:id
    if (method === "PATCH" && scheduleIdMatch) {
      const body = (await req.json()) as Record<string, unknown>;
      try {
        const sch = updateSchedule(scheduleIdMatch, body);
        if (!sch) return error("Schedule not found", 404);
        return json(sch);
      } catch (e: unknown) {
        return error(e instanceof Error ? e.message : String(e));
      }
    }

    // DELETE /api/schedules/:id
    if (method === "DELETE" && scheduleIdMatch) {
      const ok = deleteSchedule(scheduleIdMatch);
      if (!ok) return error("Schedule not found", 404);
      return json({ ok: true });
    }

    // POST /api/schedules/:id/run-now —— 立即触发一次（不影响 next_run_at）
    const runNowMatch = extractParam(path, /^\/api\/schedules\/([\w.\-]+)\/run-now$/);
    if (method === "POST" && runNowMatch) {
      const sch = getSchedule(runNowMatch);
      if (!sch) return error("Schedule not found", 404);
      try {
        const task = await startTaskFromTemplate({
          workflow: sch.workflow,
          title: sch.title,
          requirement: sch.requirement ?? undefined,
        });
        // 更新最近触发记录，但保留原 next_run_at 不动
        markScheduleFired(sch.id, task.id, sch.next_run_at, sch.enabled === 0);
        return json({ ok: true, taskId: task.id });
      } catch (e: unknown) {
        if (e instanceof StartTaskError) return error(e.message, e.status);
        return error(e instanceof Error ? e.message : String(e), 500);
      }
    }

    // ─────────── 首跑配置（setup） ───────────

    if (method === "GET" && path === "/api/setup/status") {
      const { runChecks } = await import("../core/doctor");
      const { getKv } = await import("../core/db");
      const report = await runChecks({ level: 1 });
      let dismissed = false;
      try {
        dismissed = getKv("setup.dismissed") === "1";
      } catch {
        // kv 表未建（迁移未跑）时跳过 dismissed 读取
      }
      return json({ ...report, setupDismissed: dismissed });
    }

    if (method === "POST" && path === "/api/setup/providers") {
      const { saveProvider, PROVIDER_NAMES } = await import("../core/config");
      const { runChecks } = await import("../core/doctor");
      const body = (await req.json().catch(() => null)) as { providers?: Record<string, unknown> } | null;
      if (!body || typeof body.providers !== "object" || body.providers === null || Array.isArray(body.providers)) {
        return error("providers must be an object", 400);
      }
      for (const [name, cfg] of Object.entries(body.providers)) {
        if (!(PROVIDER_NAMES as readonly string[]).includes(name)) continue;
        if (cfg && typeof cfg === "object" && !Array.isArray(cfg)) {
          saveProvider(name as typeof PROVIDER_NAMES[number], cfg as Record<string, unknown>);
        }
      }
      const report = await runChecks({ level: 1 });
      return json({ report });
    }

    if (method === "POST" && path === "/api/setup/agents") {
      const { saveAgent } = await import("../core/config");
      const { runChecks } = await import("../core/doctor");
      const body = (await req.json().catch(() => null)) as { agents?: Record<string, unknown> } | null;
      if (!body || typeof body.agents !== "object" || body.agents === null || Array.isArray(body.agents)) {
        return error("agents must be an object", 400);
      }
      for (const [name, cfg] of Object.entries(body.agents)) {
        if (cfg && typeof cfg === "object" && !Array.isArray(cfg)) {
          saveAgent(name, cfg as Record<string, unknown>);
        }
      }
      const report = await runChecks({ level: 1 });
      return json({ report });
    }

    if (method === "POST" && path === "/api/setup/codebases") {
      const { createCodebase, nextCodebaseId } = await import("../core/codebases");
      const { listProjects, createProject, nextProjectId } = await import("../core/projects");
      const body = (await req.json().catch(() => null)) as
        | { name?: string; path?: string; project_id?: string }
        | null;
      if (!body?.name || !body?.path) {
        return error("name and path required", 400);
      }
      // 若未指定 project_id：用首个 project，没有则自动建一个 default
      let projectId = body.project_id;
      if (!projectId) {
        const projects = listProjects();
        if (projects.length > 0) {
          projectId = projects[0]!.id;
        } else {
          const p = createProject({ id: nextProjectId(), name: "default" });
          projectId = p.id;
        }
      }
      const cb = createCodebase({
        id: nextCodebaseId(),
        project_id: projectId,
        alias: body.name,
        path: body.path,
      });
      return json({ codebase: cb });
    }

    if (method === "POST" && path === "/api/setup/dismiss") {
      const { setKv } = await import("../core/db");
      setKv("setup.dismissed", "1");
      return json({ ok: true });
    }

    // ─────────── 文件系统浏览 ───────────

    // GET /api/fs/list?path=<absolute>&show_hidden=1
    if (method === "GET" && path === "/api/fs/list") {
      // 防局域网泄露本机文件树：非 loopback 绑定时禁用
      const host = CURRENT_LISTEN_HOST ?? "127.0.0.1";
      if (!isLoopbackHost(host)) {
        return error("fs-browser-disabled-on-public-bind", 403);
      }
      const reqPath = url.searchParams.get("path") ?? null;
      const showHidden = url.searchParams.get("show_hidden") === "1";
      // 省略 path 时默认返回 $HOME
      const targetPath = reqPath
        ? resolve(reqPath)
        : (process.env.HOME ?? process.env.USERPROFILE ?? resolve("/"));

      // 校验路径存在且是目录
      let stat: import("fs").Stats;
      try {
        stat = await import("node:fs/promises").then((m) => m.stat(targetPath));
      } catch {
        return error("path not found", 404);
      }
      if (!stat.isDirectory()) {
        return error("not a directory", 400);
      }

      // 计算 parent_path
      const parentRaw = dirname(targetPath);
      const parentPath = parentRaw === targetPath ? null : parentRaw;

      // 读目录条目，跳过无权限条目
      let rawEntries: import("fs").Dirent[];
      try {
        rawEntries = await readdir(targetPath, { withFileTypes: true });
      } catch {
        rawEntries = [];
      }

      const entries: { name: string; is_dir: boolean }[] = [];
      for (const ent of rawEntries) {
        // 跳过隐藏文件（以 . 开头）
        if (!showHidden && ent.name.startsWith(".")) continue;
        let isDir = false;
        try {
          isDir = ent.isDirectory() || ent.isSymbolicLink()
            ? (await import("node:fs/promises").then((m) =>
                m.stat(join(targetPath, ent.name)).then((s) => s.isDirectory()).catch(() => false)
              ))
            : false;
        } catch {
          // 权限不足 —— 跳过
          continue;
        }
        entries.push({ name: ent.name, is_dir: isDir });
      }

      // 按 (is_dir desc, name asc) 排序
      entries.sort((a, b) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      return json({ current_path: targetPath, parent_path: parentPath, entries });
    }

    // ─────────── Projects ───────────

    // GET /api/projects
    if (method === "GET" && path === "/api/projects") {
      return json({ projects: listProjects() });
    }

    // POST /api/projects
    if (method === "POST" && path === "/api/projects") {
      const body = (await req.json()) as { name?: string; description?: string | null };
      if (!body.name?.trim()) return error("name 必填");
      const id = nextProjectId();
      try {
        const project = createProject({ id, name: body.name.trim(), description: body.description ?? null });
        return json({ project }, 201);
      } catch (e: unknown) {
        const code = (e as { code?: string }).code;
        const msg = e instanceof Error ? e.message : String(e);
        if (
          code === "SQLITE_CONSTRAINT_UNIQUE" ||
          code?.startsWith("SQLITE_CONSTRAINT") ||
          msg.toLowerCase().includes("unique")
        ) {
          return error(msg, 409);
        }
        return error(msg, 500);
      }
    }

    // GET /api/projects/:id/codebases — 必须在 GET /api/projects/:id 之前
    const projectCodebasesMatch = extractParam(path, /^\/api\/projects\/([\w-]+)\/codebases$/);
    if (method === "GET" && projectCodebasesMatch) {
      if (!getProjectById(projectCodebasesMatch)) return error("project not found", 404);
      return json({ codebases: listCodebases({ projectId: projectCodebasesMatch }) });
    }

    // POST /api/projects/:id/codebases
    if (method === "POST" && projectCodebasesMatch) {
      const proj = getProjectById(projectCodebasesMatch);
      if (!proj) return error("project not found", 404);
      const body = (await req.json()) as {
        alias?: string;
        path?: string;
        default_branch?: string;
        github_owner?: string | null;
        github_repo?: string | null;
      };
      if (!body.alias?.trim() || !body.path?.trim()) {
        return error("alias 和 path 必填");
      }
      const cbId = nextCodebaseId();
      try {
        const codebase = createCodebase({
          id: cbId,
          project_id: projectCodebasesMatch,
          alias: body.alias.trim(),
          path: body.path.trim(),
          default_branch: body.default_branch?.trim() || "main",
          github_owner: body.github_owner ?? null,
          github_repo: body.github_repo ?? null,
        });
        return json({ codebase }, 201);
      } catch (e: unknown) {
        const code = (e as { code?: string }).code;
        const msg = e instanceof Error ? e.message : String(e);
        if (
          code === "SQLITE_CONSTRAINT_UNIQUE" ||
          code?.startsWith("SQLITE_CONSTRAINT") ||
          msg.toLowerCase().includes("unique")
        ) {
          return error(msg, 409);
        }
        return error(msg, 500);
      }
    }

    // GET /api/projects/:id/requirements — 必须在 GET /api/projects/:id 之前
    const projectRequirementsMatch = extractParam(path, /^\/api\/projects\/([\w-]+)\/requirements$/);
    if (method === "GET" && projectRequirementsMatch) {
      if (!getProjectById(projectRequirementsMatch)) return error("project not found", 404);
      return json({ requirements: listRequirementsByProject(projectRequirementsMatch).map((r) => withRepoIdAlias(r)) });
    }

    // GET /api/projects/:id
    const projectIdMatch = extractParam(path, /^\/api\/projects\/([\w-]+)$/);
    if (method === "GET" && projectIdMatch) {
      const project = getProjectById(projectIdMatch);
      if (!project) return error("project not found", 404);
      return json({ project });
    }

    // PUT /api/projects/:id
    if (method === "PUT" && projectIdMatch) {
      const body = (await req.json()) as { name?: string; description?: string | null };
      if (body.name !== undefined && body.name.trim() === "") return error("name 不能为空", 400);
      const project = updateProject(projectIdMatch, {
        name: body.name?.trim(),
        description: body.description,
      });
      if (!project) return error("project not found", 404);
      return json({ project });
    }

    // DELETE /api/projects/:id — 级联删除需求、codebase（含子模块）后再删项目
    if (method === "DELETE" && projectIdMatch) {
      if (!getProjectById(projectIdMatch)) return error("project not found", 404);
      const reqs = listRequirementsByProject(projectIdMatch);
      for (const r of reqs) deleteRequirement(r.id);
      const codebases = listCodebases({ projectId: projectIdMatch });
      for (const cb of codebases) deleteCodebase(cb.id);
      deleteProject(projectIdMatch);
      return json({ ok: true });
    }

    // ─────────── Codebases（新主路由，响应字段统一 codebase / codebases） ───────────

    // GET /api/codebases
    if (method === "GET" && path === "/api/codebases") {
      return json({ codebases: listCodebases() });
    }

    // POST /api/codebases
    if (method === "POST" && path === "/api/codebases") {
      const body = (await req.json()) as {
        alias?: string;
        path?: string;
        default_branch?: string;
        github_owner?: string | null;
        github_repo?: string | null;
        project_id?: string;
      };
      if (!body.alias?.trim() || !body.path?.trim()) {
        return error("alias 和 path 必填");
      }
      const projectId = body.project_id?.trim() ?? "";
      try {
        const id = nextCodebaseId();
        const codebase = createCodebase({
          id,
          project_id: projectId,
          alias: body.alias.trim(),
          path: body.path.trim(),
          default_branch: body.default_branch?.trim() || "main",
          github_owner: body.github_owner ?? null,
          github_repo: body.github_repo ?? null,
        });
        return json({ codebase }, 201);
      } catch (e: unknown) {
        const code = (e as { code?: string }).code;
        const msg = e instanceof Error ? e.message : String(e);
        if (
          code === "SQLITE_CONSTRAINT_UNIQUE" ||
          code?.startsWith("SQLITE_CONSTRAINT") ||
          msg.toLowerCase().includes("unique")
        ) {
          return error(msg, 409);
        }
        return error(msg, 500);
      }
    }

    // GET /api/codebases/:id
    const codebaseIdMatch = extractParam(path, /^\/api\/codebases\/([\w.\-]+)$/);
    if (method === "GET" && codebaseIdMatch) {
      const codebase = getCodebaseById(codebaseIdMatch);
      if (!codebase) return error("codebase not found", 404);
      return json({ codebase });
    }

    // PUT /api/codebases/:id
    if (method === "PUT" && codebaseIdMatch) {
      const existing = getCodebaseById(codebaseIdMatch);
      if (!existing) return error("codebase not found", 404);
      const body = (await req.json()) as {
        alias?: string;
        path?: string;
        default_branch?: string;
        github_owner?: string | null;
        github_repo?: string | null;
      };
      if (body.alias !== undefined) {
        const trimmed = body.alias.trim();
        if (!trimmed) return error("alias 不能为空", 400);
        body.alias = trimmed;
      }
      if (body.path !== undefined) {
        const trimmed = body.path.trim();
        if (!trimmed) return error("path 不能为空", 400);
        body.path = trimmed;
      }
      if (body.default_branch !== undefined) {
        const trimmed = body.default_branch.trim();
        if (!trimmed) delete body.default_branch;
        else body.default_branch = trimmed;
      }
      try {
        const codebase = updateCodebase(codebaseIdMatch, {
          alias: body.alias,
          path: body.path,
          default_branch: body.default_branch,
          github_owner: body.github_owner,
          github_repo: body.github_repo,
        });
        return json({ codebase });
      } catch (e: unknown) {
        const code = (e as { code?: string }).code;
        const msg = e instanceof Error ? e.message : String(e);
        if (
          code === "SQLITE_CONSTRAINT_UNIQUE" ||
          code?.startsWith("SQLITE_CONSTRAINT") ||
          msg.toLowerCase().includes("unique")
        ) {
          return error(msg, 409);
        }
        return error(msg, 500);
      }
    }

    // DELETE /api/codebases/:id
    if (method === "DELETE" && codebaseIdMatch) {
      const existing = getCodebaseById(codebaseIdMatch);
      if (!existing) return error("codebase not found", 404);
      deleteCodebase(codebaseIdMatch);
      return json({ ok: true });
    }

    // POST /api/codebases/:id/healthcheck
    const codebaseHealthMatch = extractParam(path, /^\/api\/codebases\/([\w.\-]+)\/healthcheck$/);
    if (method === "POST" && codebaseHealthMatch) {
      const codebase = getCodebaseById(codebaseHealthMatch);
      if (!codebase) return error("codebase not found", 404);
      const health = await checkCodebaseHealth(codebase.path);
      const patch: { github_owner?: string; github_repo?: string } = {};
      if (health.github_owner && !codebase.github_owner) patch.github_owner = health.github_owner;
      if (health.github_repo && !codebase.github_repo) patch.github_repo = health.github_repo;
      if (patch.github_owner !== undefined || patch.github_repo !== undefined) {
        updateCodebase(codebaseHealthMatch, patch);
      }
      if (health.healthy && !codebase.parent_codebase_id) {
        try {
          const dr = discoverSubmodules(codebase.id);
          return Response.json({
            healthy: true,
            issues: health.issues,
            submodules: {
              added: dr.added.map(r => ({
                id: r.id,
                alias: r.alias,
                path: r.submodule_path,
              })),
              existing: dr.existing.length,
              warnings: dr.warnings,
            },
          });
        } catch (e: unknown) {
          return Response.json({
            healthy: true,
            issues: health.issues,
            submodules: { error: (e as Error).message },
          });
        }
      }
      return json({ healthy: health.healthy, issues: health.issues });
    }

    // POST /api/codebases/:id/rediscover-submodules
    const codebaseRediscoverMatch = extractParam(path, /^\/api\/codebases\/([\w.\-]+)\/rediscover-submodules$/);
    if (method === "POST" && codebaseRediscoverMatch) {
      const codebase = getCodebaseById(codebaseRediscoverMatch);
      if (!codebase) return error("codebase not found", 404);
      if (codebase.parent_codebase_id) return error("子模块自身不能再发现子模块（不支持嵌套）");
      try {
        const r = discoverSubmodules(codebaseRediscoverMatch);
        return json({
          added: r.added.map(x => ({
            id: x.id,
            alias: x.alias,
            submodule_path: x.submodule_path,
          })),
          existing_count: r.existing.length,
          warnings: r.warnings,
        });
      } catch (e: unknown) {
        return error((e as Error).message);
      }
    }

    // GET /api/codebases/:id/submodules
    const codebaseSubmodulesMatch = extractParam(path, /^\/api\/codebases\/([\w.\-]+)\/submodules$/);
    if (method === "GET" && codebaseSubmodulesMatch) {
      const codebase = getCodebaseById(codebaseSubmodulesMatch);
      if (!codebase) return error("codebase not found", 404);
      return json({ submodules: listSubmodules(codebaseSubmodulesMatch) });
    }

    // ─────────── Repos（旧路由别名，响应字段保留 repo / repos；P6 清理） ───────────

    // GET /api/repos
    if (method === "GET" && path === "/api/repos") {
      return json({ repos: listCodebases() });
    }

    // POST /api/repos
    if (method === "POST" && path === "/api/repos") {
      const body = (await req.json()) as {
        alias?: string;
        path?: string;
        default_branch?: string;
        github_owner?: string | null;
        github_repo?: string | null;
        project_id?: string;
      };
      if (!body.alias?.trim() || !body.path?.trim()) {
        return error("alias 和 path 必填");
      }
      // P3 待修：API 层应强制要求 project_id；当前 P1 阶段仅核心改名，project_id 默认空字符串占位（迁移后存量数据已填值）。
      const projectId = body.project_id?.trim() ?? "";
      try {
        const id = nextCodebaseId();
        const repo = createCodebase({
          id,
          project_id: projectId,
          alias: body.alias.trim(),
          path: body.path.trim(),
          default_branch: body.default_branch?.trim() || "main",
          github_owner: body.github_owner ?? null,
          github_repo: body.github_repo ?? null,
        });
        return json({ repo }, 201);
      } catch (e: unknown) {
        const code = (e as { code?: string }).code;
        const msg = e instanceof Error ? e.message : String(e);
        if (
          code === "SQLITE_CONSTRAINT_UNIQUE" ||
          code?.startsWith("SQLITE_CONSTRAINT") ||
          msg.toLowerCase().includes("unique")
        ) {
          return error(msg, 409);
        }
        return error(msg, 500);
      }
    }

    // GET /api/repos/:id
    const repoIdMatch = extractParam(path, /^\/api\/repos\/([\w.\-]+)$/);
    if (method === "GET" && repoIdMatch) {
      const repo = getCodebaseById(repoIdMatch);
      if (!repo) return error("repo not found", 404);
      return json({ repo });
    }

    // PUT /api/repos/:id
    if (method === "PUT" && repoIdMatch) {
      const existing = getCodebaseById(repoIdMatch);
      if (!existing) return error("repo not found", 404);
      const body = (await req.json()) as {
        alias?: string;
        path?: string;
        default_branch?: string;
        github_owner?: string | null;
        github_repo?: string | null;
      };
      if (body.alias !== undefined) {
        const trimmed = body.alias.trim();
        if (!trimmed) return error("alias 不能为空", 400);
        body.alias = trimmed;
      }
      if (body.path !== undefined) {
        const trimmed = body.path.trim();
        if (!trimmed) return error("path 不能为空", 400);
        body.path = trimmed;
      }
      if (body.default_branch !== undefined) {
        const trimmed = body.default_branch.trim();
        if (!trimmed) delete body.default_branch;
        else body.default_branch = trimmed;
      }
      try {
        const repo = updateCodebase(repoIdMatch, {
          alias: body.alias,
          path: body.path,
          default_branch: body.default_branch,
          github_owner: body.github_owner,
          github_repo: body.github_repo,
        });
        return json({ repo });
      } catch (e: unknown) {
        const code = (e as { code?: string }).code;
        const msg = e instanceof Error ? e.message : String(e);
        if (
          code === "SQLITE_CONSTRAINT_UNIQUE" ||
          code?.startsWith("SQLITE_CONSTRAINT") ||
          msg.toLowerCase().includes("unique")
        ) {
          return error(msg, 409);
        }
        return error(msg, 500);
      }
    }

    // DELETE /api/repos/:id
    if (method === "DELETE" && repoIdMatch) {
      const existing = getCodebaseById(repoIdMatch);
      if (!existing) return error("repo not found", 404);
      deleteCodebase(repoIdMatch);
      return json({ ok: true });
    }

    // POST /api/repos/:id/healthcheck
    const repoHealthMatch = extractParam(path, /^\/api\/repos\/([\w.\-]+)\/healthcheck$/);
    if (method === "POST" && repoHealthMatch) {
      const repo = getCodebaseById(repoHealthMatch);
      if (!repo) return error("repo not found", 404);
      const health = await checkCodebaseHealth(repo.path);
      // 自动回填 github_owner / github_repo（仅当 DB 里为空且检查结果有值，逐字段独立判断避免覆盖已有值）
      const patch: { github_owner?: string; github_repo?: string } = {};
      if (health.github_owner && !repo.github_owner) patch.github_owner = health.github_owner;
      if (health.github_repo && !repo.github_repo) patch.github_repo = health.github_repo;
      if (patch.github_owner !== undefined || patch.github_repo !== undefined) {
        updateCodebase(repoHealthMatch, patch);
      }
      // 健康检查通过 + 回填后，扫 .gitmodules 自动注册子模块（仅顶级 repo，子模块自身跳过避免递归）
      if (health.healthy && !repo.parent_codebase_id) {
        try {
          const dr = discoverSubmodules(repo.id);
          return Response.json({
            healthy: true,
            issues: health.issues,
            submodules: {
              added: dr.added.map(r => ({
                id: r.id,
                alias: r.alias,
                path: r.submodule_path,
              })),
              existing: dr.existing.length,
              warnings: dr.warnings,
            },
          });
        } catch (e: unknown) {
          return Response.json({
            healthy: true,
            issues: health.issues,
            submodules: { error: (e as Error).message },
          });
        }
      }
      // 否则维持原响应：仅 healthy + issues，无 submodules 字段
      return json({ healthy: health.healthy, issues: health.issues });
    }

    // POST /api/repos/:id/rediscover-submodules
    const repoRediscoverMatch = extractParam(path, /^\/api\/repos\/([\w.\-]+)\/rediscover-submodules$/);
    if (method === "POST" && repoRediscoverMatch) {
      const repo = getCodebaseById(repoRediscoverMatch);
      if (!repo) return error("repo not found", 404);
      if (repo.parent_codebase_id) return error("子模块自身不能再发现子模块（不支持嵌套）");
      try {
        const r = discoverSubmodules(repoRediscoverMatch);
        return json({
          added: r.added.map(x => ({
            id: x.id,
            alias: x.alias,
            submodule_path: x.submodule_path,
          })),
          existing_count: r.existing.length,
          warnings: r.warnings,
        });
      } catch (e: unknown) {
        return error((e as Error).message);
      }
    }

    // GET /api/repos/:id/submodules
    const repoSubmodulesMatch = extractParam(path, /^\/api\/repos\/([\w.\-]+)\/submodules$/);
    if (method === "GET" && repoSubmodulesMatch) {
      const repo = getCodebaseById(repoSubmodulesMatch);
      if (!repo) return error("repo not found", 404);
      // 子模块自身 / 普通父 repo 都按 listSubmodules 走（前者返回空数组）
      return json({ submodules: listSubmodules(repoSubmodulesMatch) });
    }

    // ─────────── Requirements ───────────

    // GET /api/requirements
    if (method === "GET" && path === "/api/requirements") {
      // codebase_id 是新字段名；repo_id 旧名继续兼容（web UI 还没迁移）
      const codebaseId =
        url.searchParams.get("codebase_id") ??
        url.searchParams.get("repo_id") ??
        undefined;
      const projectId = url.searchParams.get("project_id") ?? undefined;
      const status = url.searchParams.get("status") ?? undefined;
      return json({
        requirements: listRequirements({ codebase_id: codebaseId, project_id: projectId, status })
          .map((r) => withRepoIdAlias(r)),
      });
    }

    // POST /api/requirements/extract
    if (method === "POST" && path === "/api/requirements/extract") {
      const { runClarifierExtract } = await import("./requirement-extract");
      const { getProjectById } = await import("../core/projects");
      const { getCodebaseById } = await import("../core/codebases");
      const body = (await req.json().catch(() => null)) as
        | { raw_text?: string; project_id?: string; codebase_id?: string | null }
        | null;
      if (!body || typeof body.raw_text !== "string" || !body.raw_text.trim()) {
        return error("raw_text required", 400);
      }
      if (typeof body.project_id !== "string" || !body.project_id.trim()) {
        return error("project_id required", 400);
      }
      const proj = getProjectById(body.project_id);
      if (!proj) return error("project not found", 404);
      if (body.codebase_id) {
        const cb = getCodebaseById(body.codebase_id);
        if (!cb) return error("codebase not found", 404);
        if (cb.project_id !== body.project_id) {
          return error("codebase does not belong to project", 400);
        }
      }
      const result = await runClarifierExtract({
        raw_text: body.raw_text,
        project_id: body.project_id,
        codebase_id: body.codebase_id ?? null,
      });
      return json(result);
    }

    // POST /api/requirements
    if (method === "POST" && path === "/api/requirements") {
      const body = (await req.json()) as {
        project_id?: string;
        codebase_id?: string | null;
        repo_id?: string;       // 旧字段名兼容
        title?: string;
        spec_md?: string;
        chat_session_id?: string | null;
      };
      // 兼容旧字段名：repo_id 等价于 codebase_id（web UI 还没迁移）
      const codebaseId = body.codebase_id ?? body.repo_id ?? null;
      if (!body.title?.trim()) {
        return error("title 必填");
      }
      // 必须能确定 project_id：要么调用方直接传，要么从 codebase 反查
      let projectId = body.project_id?.trim();
      if (codebaseId) {
        const cb = getCodebaseById(codebaseId);
        if (!cb) return error("codebase not found", 404);
        projectId = projectId ?? cb.project_id;
      }
      if (!projectId) {
        return error("project_id 必填（或提供 codebase_id 由 daemon 反查）");
      }
      const id = nextRequirementId();
      try {
        createRequirement({
          id,
          project_id: projectId,
          codebase_id: codebaseId,
          title: body.title.trim(),
          spec_md: body.spec_md ?? "",
          chat_session_id: body.chat_session_id ?? null,
        });
        // 自动进入澄清流程（触发 requirement-clarifier 后台生成问题）
        const clarifying = setRequirementStatus(id, "clarifying");
        return json({ requirement: withRepoIdAlias(clarifying) }, 201);
      } catch (e: unknown) {
        return error((e as Error).message, 500);
      }
    }

    // POST /api/requirements/:id/transition
    const reqTransitionMatch = extractParam(path, /^\/api\/requirements\/([\w-]+)\/transition$/);
    if (reqTransitionMatch && method === "POST") {
      const body = (await req.json()) as { to?: string };
      if (!body.to?.trim()) return error("to 必填");
      if (!getRequirementById(reqTransitionMatch)) return error("requirement not found", 404);
      try {
        return json({ requirement: withRepoIdAlias(setRequirementStatus(reqTransitionMatch, body.to.trim())) });
      } catch (e: unknown) {
        return error((e as Error).message);
      }
    }

    // POST /api/requirements/:id/enqueue
    const reqEnqueueMatch = extractParam(path, /^\/api\/requirements\/([\w-]+)\/enqueue$/);
    if (reqEnqueueMatch && method === "POST") {
      const id = reqEnqueueMatch;
      const r = getRequirementById(id);
      if (!r) return error("requirement not found", 404);
      if (!r.codebase_id) return error("请先关联代码库再入队");
      if (!(r.spec_md ?? "").trim()) {
        return error("需求规约为空，请先完成澄清或手动填写规约");
      }
      // 仅置 queued；调度器（src/daemon/requirement-scheduler.ts）会监听 status 变化触发创建 task
      try {
        return json({ requirement: withRepoIdAlias(setRequirementStatus(id, "queued")) });
      } catch (e: unknown) {
        return error((e as Error).message);
      }
    }

    // POST /api/requirements/:id/inject_feedback
    const reqInjectMatch = extractParam(path, /^\/api\/requirements\/([\w-]+)\/inject_feedback$/);
    if (reqInjectMatch && method === "POST") {
      const id = reqInjectMatch;
      const body = (await req.json()) as {
        body?: string;
        source?: "manual" | "github_review";
        github_review_id?: string;
      };
      if (!body.body?.trim()) return error("body 必填");
      const r = getRequirementById(id);
      if (!r) return error("requirement not found", 404);
      appendFeedback({
        requirement_id: id,
        source: body.source ?? "manual",
        body: body.body.trim(),
        github_review_id: body.github_review_id ?? null,
      });
      // P3：如果当前 awaiting_review，触发 fix_revision
      // run_await_review 阶段函数循环会检测到 status 变化，emit jump trigger 切换到 fix_revision 阶段
      if (r.status === "awaiting_review") {
        try {
          setRequirementStatus(id, "fix_revision");
        } catch (e: unknown) {
          log.warn("inject_feedback 触发 fix_revision 失败（反馈已写入）[req=%s err=%s]", id, (e as Error).message);
        }
      }
      return json({ ok: true });
    }

    // POST /api/requirements/:id/cancel
    const reqCancelMatch = extractParam(path, /^\/api\/requirements\/([\w-]+)\/cancel$/);
    if (reqCancelMatch && method === "POST") {
      if (!getRequirementById(reqCancelMatch)) return error("requirement not found", 404);
      try {
        return json({ requirement: withRepoIdAlias(setRequirementStatus(reqCancelMatch, "cancelled")) });
      } catch (e: unknown) {
        return error((e as Error).message);
      }
    }

    // GET /api/requirements/:id/sub-prs
    const reqSubPrsMatch = extractParam(path, /^\/api\/requirements\/([\w.\-]+)\/sub-prs$/);
    if (method === "GET" && reqSubPrsMatch) {
      const r = getRequirementById(reqSubPrsMatch);
      if (!r) return error("requirement not found", 404);
      return json({ sub_prs: listSubPrs(reqSubPrsMatch) });
    }

    // POST /api/requirements/:id/finish-clarification
    const finishMatch = path.match(/^\/api\/requirements\/([\w.\-]+)\/finish-clarification$/);
    if (method === "POST" && finishMatch) {
      const id = decodeURIComponent(finishMatch[1]);
      const req2 = getRequirementById(id);
      if (!req2) return error("requirement not found", 404);
      finishClarification(id);
      const updated = getRequirementById(id);
      return json({ requirement: withRepoIdAlias(updated) });
    }

    // GET /api/requirements/:id/clarifier-round
    const clarifierRoundMatch = path.match(/^\/api\/requirements\/([\w.\-]+)\/clarifier-round$/);
    if (method === "GET" && clarifierRoundMatch) {
      const id = decodeURIComponent(clarifierRoundMatch[1]);
      if (!getRequirementById(id)) return error("requirement not found", 404);
      return json({ round: getRound(id) ?? null });
    }

    // POST /api/requirements/:id/retry-clarify
    const retryMatch = path.match(/^\/api\/requirements\/([\w.\-]+)\/retry-clarify$/);
    if (method === "POST" && retryMatch) {
      const id = decodeURIComponent(retryMatch[1]);
      const req2 = getRequirementById(id);
      if (!req2) return error("requirement not found", 404);
      await runClarifierRound(id);
      return json({ ok: true });
    }

    // GET /api/requirements/:id/spec-revisions
    const revsMatch = path.match(/^\/api\/requirements\/([\w.\-]+)\/spec-revisions$/);
    if (method === "GET" && revsMatch) {
      const id = decodeURIComponent(revsMatch[1]);
      const req2 = getRequirementById(id);
      if (!req2) return error("requirement not found", 404);
      return json({ revisions: listSpecRevisionsByRequirement(id) });
    }

    // ─────────── Questions（评论线程） ───────────

    // POST /api/requirements/:reqId/questions/:qid/replies — 必须在 /:qid 之前
    const reqQidRepliesMatch = path.match(/^\/api\/requirements\/([\w-]+)\/questions\/([\w-]+)\/replies$/);
    if (method === "POST" && reqQidRepliesMatch) {
      const [, reqId, qid] = reqQidRepliesMatch;
      if (!getRequirementById(reqId)) return error("requirement not found", 404);
      const q = getQuestionById(qid);
      if (!q) return error("question not found", 404);
      const body = (await req.json()) as { author_role?: string; text?: string };
      if (!body.author_role || !body.text) return error("author_role 和 text 必填");
      if (body.author_role !== "agent" && body.author_role !== "user") {
        return error('author_role 必须是 "agent" 或 "user"');
      }
      try {
        const replyId = nextReplyId();
        const reply = addReply({
          id: replyId,
          question_id: qid,
          author_role: body.author_role as "agent" | "user",
          text: body.text,
        });
        return json({ reply }, 201);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return error(msg, 500);
      }
    }

    // POST /api/requirements/:reqId/questions/:qid/resolve — 必须在 /:qid 之前
    const reqQidResolveMatch = path.match(/^\/api\/requirements\/([\w-]+)\/questions\/([\w-]+)\/resolve$/);
    if (method === "POST" && reqQidResolveMatch) {
      const [, reqId, qid] = reqQidResolveMatch;
      if (!getRequirementById(reqId)) return error("requirement not found", 404);
      if (!getQuestionById(qid)) return error("question not found", 404);
      resolveQuestion(qid);
      // 全部问题解决时通知 clarifier 决定是否继续追问
      const allQuestions = listQuestionsByRequirement(reqId);
      if (allQuestions.length > 0 && allQuestions.every(q => q.status === "resolved")) {
        emit({ type: "requirement:all-questions-resolved", payload: { id: reqId } });
      }
      return json({ ok: true });
    }

    // GET /api/requirements/:reqId/questions/:qid
    const reqQidMatch = path.match(/^\/api\/requirements\/([\w-]+)\/questions\/([\w-]+)$/);
    if (method === "GET" && reqQidMatch) {
      const [, reqId, qid] = reqQidMatch;
      if (!getRequirementById(reqId)) return error("requirement not found", 404);
      const q = getQuestionById(qid);
      if (!q) return error("question not found", 404);
      return json({ question: q });
    }

    // GET /api/requirements/:reqId/questions — 必须在 /:reqId 之前
    const reqQuestionsMatch = extractParam(path, /^\/api\/requirements\/([\w-]+)\/questions$/);
    if (method === "GET" && reqQuestionsMatch) {
      if (!getRequirementById(reqQuestionsMatch)) return error("requirement not found", 404);
      return json({ questions: listQuestionsByRequirement(reqQuestionsMatch) });
    }

    // POST /api/requirements/:reqId/questions
    if (method === "POST" && reqQuestionsMatch) {
      if (!getRequirementById(reqQuestionsMatch)) return error("requirement not found", 404);
      const body = (await req.json()) as { agent_text?: string };
      if (!body.agent_text?.trim()) return error("agent_text 必填");
      const qId = nextQuestionId();
      const question = createQuestion({ id: qId, requirement_id: reqQuestionsMatch, agent_text: body.agent_text.trim() });
      return json({ question }, 201);
    }

    // GET|PUT|DELETE /api/requirements/:id
    const reqDetailMatch = extractParam(path, /^\/api\/requirements\/([\w-]+)$/);
    if (reqDetailMatch) {
      const r = getRequirementById(reqDetailMatch);
      if (!r) return error("requirement not found", 404);

      if (method === "GET") {
        return json({ requirement: withRepoIdAlias(r), feedbacks: listFeedbacks(reqDetailMatch) });
      }
      if (method === "PUT") {
        const body = (await req.json()) as {
          title?: string;
          spec_md?: string;
          codebase_id?: string | null;
          chat_session_id?: string | null;
        };
        if (body.title !== undefined && !body.title.trim()) {
          return error("title 不能为空");
        }
        if (body.codebase_id !== undefined && body.codebase_id !== null) {
          if (!getCodebaseById(body.codebase_id)) return error("codebase not found", 404);
        }
        return json({ requirement: withRepoIdAlias(updateRequirement(reqDetailMatch, body)) });
      }
      if (method === "DELETE") {
        if (["running", "fix_revision"].includes(r.status)) {
          return error(`需求正在执行中（status=${r.status}），请先取消再删除`);
        }
        deleteRequirement(reqDetailMatch);
        return json({ ok: true });
      }
    }

    // GET /api/tasks/:id
    const taskIdMatch = extractParam(path, /^\/api\/tasks\/([\w.\-]+)$/);
    if (method === "GET" && taskIdMatch) {
      const task = getTask(taskIdMatch);
      if (!task) return error("Task not found", 404);
      // 附加 workspace 路径（方便 UI 展示 / 用户 cd 过去）
      return json({ ...task, workspace: getTaskWorkspace(taskIdMatch) });
    }

    // POST /api/tasks/:id/cancel
    const cancelMatch = extractParam(path, /^\/api\/tasks\/([\w.\-]+)\/cancel$/);
    if (method === "POST" && cancelMatch) {
      try {
        return json(cancelTaskAction(cancelMatch));
      } catch (e: unknown) {
        if (e instanceof TaskActionError) return error(e.message, e.status);
        return error(e instanceof Error ? e.message : String(e), 500);
      }
    }

    // POST /api/tasks/:id/restart — 把未完成的任务从当前阶段重新执行（dangling 救援用）
    const restartMatch = extractParam(path, /^\/api\/tasks\/([\w.\-]+)\/restart$/);
    if (method === "POST" && restartMatch) {
      try {
        return json(restartTaskAction(restartMatch));
      } catch (e: unknown) {
        if (e instanceof TaskActionError) return error(e.message, e.status);
        return error(e instanceof Error ? e.message : String(e), 500);
      }
    }

    // POST /api/tasks/:id/answer — 用户回答 agent 的 ask_user 提问
    const answerMatch = extractParam(path, /^\/api\/tasks\/([\w.\-]+)\/answer$/);
    if (method === "POST" && answerMatch) {
      const body = await req.json() as { text?: string };
      try {
        return json(await answerTaskAction(answerMatch, body.text ?? ""));
      } catch (e: unknown) {
        if (e instanceof TaskActionError) return error(e.message, e.status);
        return error(e instanceof Error ? e.message : String(e), 500);
      }
    }

    // POST /api/tasks/:id/decide  — gate phase 的人工决断（pass / reject / cancel）
    const decideMatch = extractParam(path, /^\/api\/tasks\/([\w.\-]+)\/decide$/);
    if (method === "POST" && decideMatch) {
      const body = await req.json() as { decision: string; note?: string };
      const taskId = decideMatch;
      if (!body.decision || !["pass", "reject", "cancel"].includes(body.decision)) {
        return error("decision must be one of: pass, reject, cancel");
      }
      const note = body.note?.trim() ?? "";
      if (body.decision === "reject" && !note) {
        return error("驳回必须填写理由（让 agent 知道改进方向）");
      }

      const task = getTask(taskId);
      if (!task) return error("Task not found", 404);

      // 必须处于 awaiting_<phase>
      if (!task.status.startsWith("awaiting_")) {
        return error(`Task 未处于等待状态（current=${task.status}）`);
      }
      const phase = task.status.slice("awaiting_".length);

      const wf = getWorkflow(task.workflow);
      if (!wf) return error("Workflow not found", 500);

      const transitions = buildTransitions(wf);

      let trigger: string;
      if (body.decision === "pass") trigger = `${phase}_pass`;
      else if (body.decision === "reject") trigger = `${phase}_reject_user`;
      else trigger = "cancel";

      // 写决断元数据：task.last_user_decision + workspace/<NN-phase>/decision.md
      const decisionRecord = {
        phase,
        decision: body.decision,
        note,
        ts: new Date().toISOString(),
        by: "user",
      };
      const extraUpdates: Record<string, unknown> = {
        last_user_decision: JSON.stringify(decisionRecord),
      };
      if (body.decision === "reject") {
        // 累加该 phase 的 user 驳回计数（独立于 reviewer 驳回）
        const counts = parseDecisionCounts(task["user_reject_counts"]);
        counts[phase] = (counts[phase] ?? 0) + 1;
        extraUpdates["user_reject_counts"] = JSON.stringify(counts);
      }

      // 写 workspace/<NN-phase>/decision.md（追加历史）
      try {
        const phaseIdx = phaseIndex(wf, phase);
        if (phaseIdx >= 0) {
          const dirName = `${String(phaseIdx).padStart(2, "0")}-${phase}`;
          const phaseDir = join(getTaskWorkspace(taskId), dirName);
          if (!existsSync(phaseDir)) mkdirSync(phaseDir, { recursive: true });
          const decisionMd = renderDecisionMd(decisionRecord);
          const dPath = join(phaseDir, "decision.md");
          if (existsSync(dPath)) {
            appendFileSync(dPath, "\n\n" + decisionMd, "utf-8");
          } else {
            writeFileSync(dPath, decisionMd, "utf-8");
          }
        }
      } catch (e: unknown) {
        // 写文件失败不阻塞决断
        console.warn("写 decision.md 失败：", e instanceof Error ? e.message : e);
      }

      const [from, to] = transition(taskId, trigger, {
        transitions,
        note: note || `用户决断：${body.decision}`,
        extraUpdates,
      });

      // pass / reject 后启动下一阶段（cancel 已是终态无需启动）
      if (body.decision !== "cancel") {
        const nextPhaseName = to.startsWith("pending_") ? to.slice("pending_".length) : null;
        if (nextPhaseName) {
          executePhase(taskId, nextPhaseName).catch(() => {});
        }
      }

      return json({ from, to, decision: body.decision, note });
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

    // GET /api/tasks/:id/ws/tree?path=<relative>
    const wsTreeMatch = extractParam(path, /^\/api\/tasks\/([\w.\-]+)\/ws\/tree$/);
    if (method === "GET" && wsTreeMatch) {
      const relPath = url.searchParams.get("path") ?? "";
      try {
        const entries = listWorkspaceDir(wsTreeMatch, relPath);
        return json({ path: relPath, entries });
      } catch (e: unknown) {
        return error(e instanceof Error ? e.message : String(e), 400);
      }
    }

    // GET /api/tasks/:id/ws/file?path=<relative>
    const wsFileMatch = extractParam(path, /^\/api\/tasks\/([\w.\-]+)\/ws\/file$/);
    if (method === "GET" && wsFileMatch) {
      const relPath = url.searchParams.get("path") ?? "";
      if (!relPath) return error("path 参数必填", 400);
      try {
        const file = readWorkspaceFile(wsFileMatch, relPath);
        return json(file);
      } catch (e: unknown) {
        return error(e instanceof Error ? e.message : String(e), 400);
      }
    }

    // GET /api/tasks/:id/ws/download?path=<relative> —— 二进制原样下载单文件
    const wsDownloadMatch = extractParam(path, /^\/api\/tasks\/([\w.\-]+)\/ws\/download$/);
    if (method === "GET" && wsDownloadMatch) {
      const relPath = url.searchParams.get("path") ?? "";
      if (!relPath) return error("path 参数必填", 400);
      try {
        const abs = resolveWorkspacePath(wsDownloadMatch, relPath);
        if (!abs) return error("非法路径", 400);
        const fileName = relPath.split(/[/\\]/).pop() ?? "file";
        const file = Bun.file(abs);
        if (!(await file.exists())) return error("文件不存在", 404);
        return new Response(file, {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": `attachment; filename="${encodeURIComponent(fileName)}"`,
            ...cors,
          },
        });
      } catch (e: unknown) {
        return error(e instanceof Error ? e.message : String(e), 400);
      }
    }

    // GET /api/tasks/:id/ws/zip — 整个 workspace 打包
    const wsZipMatch = extractParam(path, /^\/api\/tasks\/([\w.\-]+)\/ws\/zip$/);
    if (method === "GET" && wsZipMatch) {
      try {
        const proc = spawnWorkspaceZip(wsZipMatch);
        return new Response(proc.stdout as ReadableStream, {
          headers: {
            "Content-Type": "application/zip",
            "Content-Disposition": `attachment; filename="workspace-${wsZipMatch}.zip"`,
            ...cors,
          },
        });
      } catch (e: unknown) {
        return error(e instanceof Error ? e.message : String(e), 500);
      }
    }

    // DELETE /api/tasks/:id/ws — 手动清理 workspace
    const wsDeleteMatch = extractParam(path, /^\/api\/tasks\/([\w.\-]+)\/ws$/);
    if (method === "DELETE" && wsDeleteMatch) {
      try {
        const removed = deleteTaskWorkspace(wsDeleteMatch);
        return json({ ok: true, removed });
      } catch (e: unknown) {
        return error(e instanceof Error ? e.message : String(e), 500);
      }
    }

    // DELETE /api/tasks/:id — 彻底删除任务（DB + 文件 + 锁；仅终态）
    const taskDeleteMatch = extractParam(path, /^\/api\/tasks\/([\w.\-]+)$/);
    if (method === "DELETE" && taskDeleteMatch) {
      try {
        const res = cascadeDeleteTask(taskDeleteMatch);
        return json({ ok: true, deleted: res.deleted });
      } catch (e: unknown) {
        if (e instanceof DeleteTaskError) return error(e.message, e.status);
        return error(e instanceof Error ? e.message : String(e), 500);
      }
    }

    // GET /api/workspaces/usage — 扫描所有任务的 workspace 占用（Dashboard 用）
    if (method === "GET" && path === "/api/workspaces/usage") {
      try {
        const list = scanTaskWorkspaces();
        const total = list.reduce((a, it) => a + it.size, 0);
        return json({ total, tasks: list });
      } catch (e: unknown) {
        return error(e instanceof Error ? e.message : String(e), 500);
      }
    }

    // GET /api/tasks/:id/logs
    const logsMatch = extractParam(path, /^\/api\/tasks\/([\w.\-]+)\/logs$/);
    if (method === "GET" && logsMatch) {
      const limit = parseInt(url.searchParams.get("limit") ?? "100", 10);
      return json(getTaskLogs(logsMatch, limit));
    }

    // GET /api/tasks/:id/phase-logs — 列出已有阶段日志
    const phaseLogsListMatch = extractParam(path, /^\/api\/tasks\/([\w.\-]+)\/phase-logs$/);
    if (method === "GET" && phaseLogsListMatch) {
      try {
        return json(listPhaseLogs(phaseLogsListMatch));
      } catch (e: unknown) {
        return error(e instanceof Error ? e.message : String(e), 400);
      }
    }

    // GET /api/tasks/:id/phase-logs/:phase?tail=N — 读单个阶段日志
    const phaseLogReadMatch = path.match(/^\/api\/tasks\/([\w.\-]+)\/phase-logs\/([A-Za-z][\w\-]*)$/);
    if (method === "GET" && phaseLogReadMatch) {
      const [, phaseLogTaskId, phaseName] = phaseLogReadMatch;
      const tailParam = url.searchParams.get("tail");
      const tail = tailParam ? parseInt(tailParam, 10) : undefined;
      try {
        const content = readPhaseLog(phaseLogTaskId, phaseName, tail !== undefined ? { tail } : undefined);
        return json({ phase: phaseName, content });
      } catch (e: unknown) {
        return error(e instanceof Error ? e.message : String(e), 400);
      }
    }

    // GET /api/tasks/:id/agent-calls — 列出 agent 调用 transcript 摘要
    const agentCallsListMatch = extractParam(path, /^\/api\/tasks\/([\w.\-]+)\/agent-calls$/);
    if (method === "GET" && agentCallsListMatch) {
      try {
        return json(listAgentCalls(agentCallsListMatch));
      } catch (e: unknown) {
        return error(e instanceof Error ? e.message : String(e), 400);
      }
    }

    // GET /api/tasks/:id/agent-calls/:seq — 取单次调用完整记录
    const agentCallOneMatch = path.match(/^\/api\/tasks\/([\w.\-]+)\/agent-calls\/(\d+)$/);
    if (method === "GET" && agentCallOneMatch) {
      const [, acTaskId, seqStr] = agentCallOneMatch;
      const seq = parseInt(seqStr, 10);
      const rec = getAgentCall(acTaskId, seq);
      if (!rec) return error("Agent call not found", 404);
      return json(rec);
    }

    // GET /api/tasks/:id/events — 任务事件流（JSONL）
    const eventsMatch = extractParam(path, /^\/api\/tasks\/([\w.\-]+)\/events$/);
    if (method === "GET" && eventsMatch) {
      const tailParam = url.searchParams.get("tail");
      const tail = tailParam ? parseInt(tailParam, 10) : undefined;
      try {
        return json(readTaskEvents(eventsMatch, tail !== undefined ? { tail } : undefined));
      } catch (e: unknown) {
        return error(e instanceof Error ? e.message : String(e), 400);
      }
    }

    // GET /api/tasks/:id/subtasks
    const subtasksMatch = extractParam(path, /^\/api\/tasks\/([\w.\-]+)\/subtasks$/);
    if (method === "GET" && subtasksMatch) {
      return json(getSubTasks(subtasksMatch));
    }

    // GET /api/tasks/:id/phase-events
    const phaseEventsMatch = extractParam(path, /^\/api\/tasks\/([\w.\-]+)\/phase-events$/);
    if (method === "GET" && phaseEventsMatch) {
      const { listTaskPhaseEvents } = await import("../core/db");
      const events = listTaskPhaseEvents(phaseEventsMatch);
      return json({ events });
    }

    // GET /api/workflows/:name/phase-stats — 同 workflow 历史 phase 耗时 P50
    // 给 TaskPhaseTimeline 显示"此阶段历史 P50 ≈ X · 当前 Y"参考值
    const phaseStatsMatch = extractParam(path, /^\/api\/workflows\/([\w.\-]+)\/phase-stats$/);
    if (method === "GET" && phaseStatsMatch) {
      const { getWorkflowPhaseStats } = await import("../core/db");
      const stats = getWorkflowPhaseStats(phaseStatsMatch);
      return json({ stats });
    }

    // GET /api/tasks/:id/outcome
    const outcomeMatch = extractParam(path, /^\/api\/tasks\/([\w.\-]+)\/outcome$/);
    if (method === "GET" && outcomeMatch) {
      const { computeTaskOutcome } = await import("./task-outcome");
      const outcome = await computeTaskOutcome(outcomeMatch);
      if (!outcome) return error("task not in terminal state", 404);
      return json(outcome);
    }

    // ──────────────────────────────────────────────
    // 对话（chat）API
    // ──────────────────────────────────────────────

    // POST /api/chat
    // body: { message, session_id?, agent?, workflow?, title? }
    // 传 session_id 则续，否则开新 session
    if (method === "POST" && path === "/api/chat") {
      const body = await req.json() as {
        message?: string;
        session_id?: string;
        agent?: string;
        workflow?: string;
        title?: string;
      };
      if (typeof body.message !== "string" || !body.message.trim()) {
        return error("message is required");
      }
      try {
        const result = await handleChat(body);
        return json(result);
      } catch (e: unknown) {
        return error(`chat failed: ${e instanceof Error ? e.message : String(e)}`, 500);
      }
    }

    // GET /api/sessions
    if (method === "GET" && path === "/api/sessions") {
      return json(listChatSessions());
    }

    // GET /api/sessions/:id (含最近消息)
    const sessionGetMatch = extractParam(path, /^\/api\/sessions\/([\w.\-]+)$/);
    if (method === "GET" && sessionGetMatch) {
      const m = readSessionManifest(sessionGetMatch);
      if (!m) return error("session not found", 404);
      const messages = readSessionMessages(sessionGetMatch);
      return json({ ...m, messages });
    }

    // DELETE /api/sessions/:id
    if (method === "DELETE" && sessionGetMatch) {
      const ok = deleteChatSession(sessionGetMatch);
      return ok ? json({ ok: true }) : error("session not found", 404);
    }

    // GET /api/sessions/:id/messages?limit=N
    const sessionMsgsMatch = extractParam(path, /^\/api\/sessions\/([\w.\-]+)\/messages$/);
    if (method === "GET" && sessionMsgsMatch) {
      const limit = url.searchParams.get("limit");
      const n = limit ? parseInt(limit, 10) : undefined;
      return json(readSessionMessages(sessionMsgsMatch, Number.isFinite(n) ? n : undefined));
    }

    // GET /api/workflows
    if (method === "GET" && path === "/api/workflows") {
      const inMem = listWorkflows();              // registry 内存里的（含描述）
      const dbRows = listWorkflowsInDb();          // DB 的来源 + derives_from
      const sourceMap = new Map(dbRows.map((r) => [r.name, r]));
      const result = inMem.map((wf) => {
        const row = sourceMap.get(wf.name);
        return {
          ...wf,
          source: row?.source ?? "file",
          derives_from: row?.derives_from ?? null,
        };
      });
      return json(result);
    }

    // GET /api/workflows/templates — 列出可用的内置模板
    if (method === "GET" && path === "/api/workflows/templates") {
      const { listWorkflowTemplates } = await import("../core/workflow-templates");
      return json({ templates: listWorkflowTemplates() });
    }

    // POST /api/workflows/author — AI 生成 workflow.yaml + ts（不落盘，返回预览）
    if (method === "POST" && path === "/api/workflows/author") {
      const { runWorkflowAuthor } = await import("./workflow-author");
      const body = (await req.json().catch(() => null)) as
        | { description?: string; prior_yaml?: string; prior_ts?: string }
        | null;
      if (!body || typeof body.description !== "string" || !body.description.trim()) {
        return error("description required", 400);
      }
      const result = await runWorkflowAuthor({
        description: body.description,
        prior_yaml: typeof body.prior_yaml === "string" ? body.prior_yaml : undefined,
        prior_ts: typeof body.prior_ts === "string" ? body.prior_ts : undefined,
      });
      return json(result);
    }

    // POST /api/workflows/author/save — 把 AI 生成的工作流落盘
    if (method === "POST" && path === "/api/workflows/author/save") {
      const body = (await req.json().catch(() => null)) as
        | { name?: string; yaml?: string; ts?: string }
        | null;
      if (!body?.name || !body?.yaml || !body?.ts) {
        return error("name / yaml / ts required", 400);
      }
      try {
        const { saveAuthoredWorkflow } = await import("./workflow-author");
        saveAuthoredWorkflow(body.name, body.yaml, body.ts);
        const { discover } = await import("../core/registry");
        await discover();
        return json({ ok: true, name: body.name }, 201);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        const status = msg.includes("already exists") ? 409 : msg.includes("only allows") || msg.includes("只允许") ? 400 : 500;
        return error(msg, status);
      }
    }

    // GET /api/workflows/health — 扫描 yaml.name 跟目录名不一致 / 重名碰撞
    if (method === "GET" && path === "/api/workflows/health") {
      const { scanWorkflowHealth } = await import("../core/workflow-templates");
      return json(scanWorkflowHealth());
    }

    // POST /api/workflows/health/fix-orphan — 修复指定孤儿目录（改 yaml.name 为目录名）
    if (method === "POST" && path === "/api/workflows/health/fix-orphan") {
      const body = await req.json().catch(() => null) as { dir?: string } | null;
      if (!body?.dir) return error("dir is required", 400);
      try {
        const { fixOrphanWorkflow } = await import("../core/workflow-templates");
        const r = fixOrphanWorkflow(body.dir);
        const { discover } = await import("../core/registry");
        await discover();
        emit({ type: "workflow:reloaded", payload: {} });
        return json({ ok: true, ...r });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return error(msg, msg.includes("不存在") || msg.includes("非法") ? 400 : 500);
      }
    }

    // POST /api/workflows/:name/clone — 从用户已有工作流克隆（区别于 from-template 只克隆 examples 模板）
    const wfCloneMatch = path.match(/^\/api\/workflows\/([\w.\-]+)\/clone$/);
    if (method === "POST" && wfCloneMatch) {
      const [, srcName] = wfCloneMatch;
      const body = await req.json().catch(() => null) as { name?: string } | null;
      if (!body?.name) {
        return error("name (target) required", 400);
      }
      try {
        const { cloneWorkflow } = await import("../core/workflow-templates");
        cloneWorkflow(srcName, body.name);
        const { discover } = await import("../core/registry");
        await discover();
        emit({ type: "workflow:reloaded", payload: {} });
        return json({ ok: true, name: body.name }, 201);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        const status = msg.includes("already exists") ? 409
          : msg.includes("not found") ? 404
          : msg.includes("只允许") ? 400
          : 500;
        return error(msg, status);
      }
    }

    // POST /api/workflows/from-template — 从模板克隆为新工作流
    if (method === "POST" && path === "/api/workflows/from-template") {
      const body = await req.json().catch(() => null) as { template?: string; name?: string } | null;
      if (!body?.template || !body?.name) {
        return error("template and name required", 400);
      }
      if (!/^[\w.\-]+$/.test(body.name)) {
        return error("name 只允许字母 / 数字 / ._- ", 400);
      }
      try {
        const { cloneTemplate } = await import("../core/workflow-templates");
        cloneTemplate(body.template, body.name);
        // 重新发现新加入的工作流
        const { discover } = await import("../core/registry");
        await discover();
        return json({ ok: true, name: body.name }, 201);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        const status = msg.includes("already exists") ? 409 : msg.includes("not found") ? 404 : 500;
        return error(msg, status);
      }
    }

    // POST /api/workflows — 创建工作流（文件脚手架）
    // 注：曾支持 body.derives_from 创建 DB 派生工作流，已下线（派生概念被克隆 + drawer 内
    // 编辑 ts/prompt 完全替代）；旧 DB 派生工作流仍能加载（registry composeDbWorkflow 保留），
    // 但不再支持新建。
    if (method === "POST" && path === "/api/workflows") {
      const body = await req.json() as {
        name?: string;
        description?: string;
        firstPhase?: string;
      };
      if (typeof body.name !== "string" || !body.name) return error("name is required");

      try {
        const result = createWorkflow({
          name: body.name,
          description: body.description,
          firstPhase: body.firstPhase,
        });
        await reload();
        emit({ type: "workflow:reloaded", payload: {} });
        return json({ ok: true, name: body.name, source: "file", dir: result.dir }, 201);
      } catch (e: unknown) {
        return error(`创建失败：${e instanceof Error ? e.message : String(e)}`, 400);
      }
    }

    // DELETE /api/workflows/:name — 删除工作流（区分 source）
    const wfDeleteMatch = extractParam(path, /^\/api\/workflows\/([\w.\-]+)$/);
    if (method === "DELETE" && wfDeleteMatch) {
      const row = getWorkflowFromDb(wfDeleteMatch);
      // DB 工作流走 deleteDbWorkflow
      if (row && row.source === "db") {
        try {
          deleteDbWorkflow(wfDeleteMatch);
          await reload();
          emit({ type: "workflow:reloaded", payload: {} });
          return json({ ok: true });
        } catch (e: unknown) {
          return error(`删除失败：${e instanceof Error ? e.message : String(e)}`, 400);
        }
      }
      // 文件来源走原文件目录删除
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
      const row = getWorkflowFromDb(wfMatch);
      return json({
        ...safe,
        phases: safePhasesArr,
        source: row?.source ?? "file",
        derives_from: row?.derives_from ?? null,
      });
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

    // GET /api/defaults —— 返回默认偏好（含 resolved timezone）
    if (method === "GET" && path === "/api/defaults") {
      const cfg = loadDefaultsConfig();
      return json({
        timezone: cfg.timezone ?? null,
        resolved_timezone: cfg.timezone ?? systemTimezone(),
        system_timezone: systemTimezone(),
      });
    }

    // PUT /api/defaults
    if (method === "PUT" && path === "/api/defaults") {
      const body = (await req.json()) as { timezone?: string | null };
      const tz = typeof body.timezone === "string" ? body.timezone.trim() : "";
      if (tz && !isValidTimezone(tz)) {
        return error(`时区无效：${tz}`);
      }
      try {
        saveDefaultsConfig({ timezone: tz || undefined });
        emit({ type: "config:updated", payload: {} });
        return json({ ok: true, timezone: tz || null });
      } catch (e: unknown) {
        return error(e instanceof Error ? e.message : String(e));
      }
    }

    // GET /api/workflows/:name/yaml
    const yamlReadMatch = extractParam(path, /^\/api\/workflows\/([\w.\-]+)\/yaml$/);
    if (method === "GET" && yamlReadMatch) {
      const row = getWorkflowFromDb(yamlReadMatch);
      if (row && row.source === "db") {
        return json({ yaml: row.yaml_content });
      }
      const yaml = getWorkflowYaml(yamlReadMatch);
      if (yaml === null) return error("Workflow not found", 404);
      return json({ yaml });
    }

    // GET /api/workflows/:name/export — 纯 yaml 文本响应（用于 CLI export 备份）
    // 注意：必须放在 /api/workflows/:name 通配匹配前面（位于 yaml 端点附近避免被吃掉）
    const exportMatch = extractParam(path, /^\/api\/workflows\/([\w.\-]+)\/export$/);
    if (method === "GET" && exportMatch) {
      const row = getWorkflowFromDb(exportMatch);
      let yaml: string | null = null;
      if (row && row.source === "db") {
        yaml = row.yaml_content;
      } else {
        yaml = getWorkflowYaml(exportMatch);
      }
      if (yaml === null) return error("Workflow not found", 404);
      return new Response(yaml, {
        status: 200,
        headers: { "Content-Type": "text/yaml; charset=utf-8" },
      });
    }

    // GET /api/workflows/:name/export-bundle — 导出为 JSON bundle（yaml + ts）便于分享
    const exportBundleMatch = extractParam(path, /^\/api\/workflows\/([\w.\-]+)\/export-bundle$/);
    if (method === "GET" && exportBundleMatch) {
      const wfName = exportBundleMatch;
      // yaml 来源：db 工作流读 DB 行，file 工作流读磁盘
      const row = getWorkflowFromDb(wfName);
      let yaml: string | null = null;
      if (row && row.source === "db") {
        yaml = row.yaml_content;
      } else {
        yaml = getWorkflowYaml(wfName);
      }
      if (yaml === null) return error("Workflow not found", 404);
      const ts = getWorkflowTs(wfName); // 可能为 null（prompt-only / db 工作流没磁盘 ts）
      return json({
        version: 1,
        name: wfName,
        yaml,
        ts: ts ?? null,
        exported_at: new Date().toISOString(),
      });
    }

    // POST /api/workflows/import-bundle — 从 JSON bundle 创建新工作流
    if (method === "POST" && path === "/api/workflows/import-bundle") {
      const body = await req.json().catch(() => null) as
        | { name?: string; yaml?: string; ts?: string | null }
        | null;
      if (!body || typeof body.name !== "string" || typeof body.yaml !== "string") {
        return error("name + yaml required", 400);
      }
      if (!/^[\w.\-]+$/.test(body.name)) {
        return error("name 只允许字母 / 数字 / . _ -", 400);
      }
      try {
        const { saveAuthoredWorkflow } = await import("./workflow-author");
        saveAuthoredWorkflow(body.name, body.yaml, body.ts ?? "");
        // 复用 saveAuthoredWorkflow 后的同步逻辑
        const { discover } = await import("../core/registry");
        await discover();
        emit({ type: "workflow:reloaded", payload: {} });
        return json({ ok: true, name: body.name }, 201);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        const status = msg.includes("already exists") ? 409
          : msg.includes("只允许") ? 400
          : 500;
        return error(msg, status);
      }
    }

    // GET /api/workflows/:name/ts — 读 workflow.ts 源码
    const tsReadMatch = extractParam(path, /^\/api\/workflows\/([\w.\-]+)\/ts$/);
    if (method === "GET" && tsReadMatch) {
      const content = getWorkflowTs(tsReadMatch);
      if (content === null) return error("workflow.ts not found", 404);
      return json({ content });
    }

    // POST /api/workflows/:name/dry-run — 不建 task / 不写 workspace，直接调 agent.run 试跑 prompt
    // body: { agent: string, prompt: string, timeout?: number(秒) }
    const dryRunMatch = path.match(/^\/api\/workflows\/([\w.\-]+)\/dry-run$/);
    if (method === "POST" && dryRunMatch) {
      const [, wfName] = dryRunMatch;
      const body = (await req.json().catch(() => null)) as
        | { agent?: string; prompt?: string; timeout?: number }
        | null;
      if (!body || typeof body.prompt !== "string" || !body.prompt.trim()) {
        return error("prompt is required", 400);
      }
      try {
        const { getAgent } = await import("../agents/registry");
        const agent = getAgent(body.agent || "coder", wfName);
        const startMs = Date.now();
        const result = await agent.run(body.prompt, {
          timeout: Math.max(5, Math.min(body.timeout ?? 60, 600)) * 1000,
        });
        return json({
          text: result.text,
          durationMs: Date.now() - startMs,
          usage: result.usage,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return error(msg, 500);
      }
    }

    // PUT /api/workflows/:name/phase-fn/:phase — 单个 run_<phase> 函数代码替换
    // extractParam 只取第一组 group，这里用两个 group 所以直接 path.match
    const phaseFnMatch = path.match(/^\/api\/workflows\/([\w.\-]+)\/phase-fn\/([a-z][a-z0-9_]*)$/);
    if (method === "PUT" && phaseFnMatch) {
      const [, wfName, phaseName] = phaseFnMatch;
      const body = (await req.json().catch(() => null)) as { code?: string } | null;
      if (!body || typeof body.code !== "string" || !body.code.trim()) {
        return error("code (function source) is required", 400);
      }
      try {
        const result = replaceRunFunction(wfName, phaseName, body.code);
        emit({ type: "workflow:reloaded", payload: {} });
        return json({ ok: true, mode: result.mode });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return error(msg, msg.includes("不存在") ? 404 : 400);
      }
    }

    // PUT /api/workflows/:name/yaml — 区分 source：db 走 updateDbWorkflow，file 写文件
    const yamlWriteMatch = extractParam(path, /^\/api\/workflows\/([\w.\-]+)\/yaml$/);
    if (method === "PUT" && yamlWriteMatch) {
      const body = await req.json() as { yaml: string };
      if (typeof body.yaml !== "string") return error("yaml field is required");

      const row = getWorkflowFromDb(yamlWriteMatch);
      if (row && row.source === "db") {
        try {
          updateDbWorkflow(yamlWriteMatch, { yaml_content: body.yaml });
          await reload();
          emit({ type: "workflow:reloaded", payload: {} });
          return json({ ok: true });
        } catch (e: unknown) {
          return error(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // file 来源 → 写文件（保持原行为）
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

// ──────────────────────────────────────────────
// 对话 handler
// ──────────────────────────────────────────────

interface ChatRequestBody {
  message?: string;
  session_id?: string;
  agent?: string;
  workflow?: string;
  title?: string;
  /** 默认开；传 false 关闭工具（纯聊天不做操作） */
  enable_tools?: boolean;
}

interface ChatResponsePayload {
  session_id: string;
  message: ChatMessage;
}

async function handleChat(body: ChatRequestBody): Promise<ChatResponsePayload> {
  const message = body.message!;

  // 1. 定位/创建 session
  let manifest = body.session_id ? readSessionManifest(body.session_id) : null;
  if (body.session_id && !manifest) {
    throw new Error(`session 不存在：${body.session_id}`);
  }
  const agentName = manifest?.agent ?? resolveChatAgentName({ agent: body.agent, workflow: body.workflow });
  const workflow = manifest?.workflow ?? body.workflow;

  if (!manifest) {
    manifest = createSession({
      agent: agentName,
      workflow,
      title: body.title,
    });
  }

  // 2. 追加 user 消息
  const userMsg: ChatMessage = { role: "user", content: message, ts: new Date().toISOString() };
  appendMessage(manifest.id, userMsg);

  // 3. 跑 agent.chat —— 流式 delta 通过 WS 推；POST 仍等完整结果返回
  const sid = manifest.id;
  const agent = createChatAgent(agentName, workflow);
  let assistantText = "";
  let newProviderSid: string | undefined;
  let usage: ChatMessage["usage"];
  try {
    const result = await agent.chat(message, {
      providerSessionId: manifest.provider_session_id,
      enableTools: body.enable_tools !== false,  // 默认开工具
      onDelta: (delta) => {
        try { emit({ type: "chat:delta", payload: { sessionId: sid, delta } }); } catch { /* ignore */ }
      },
    });
    assistantText = result.text;
    newProviderSid = result.providerSessionId;
    usage = result.usage;
  } catch (e: unknown) {
    const errMsg = e instanceof Error ? e.message : String(e);
    try { emit({ type: "chat:error", payload: { sessionId: sid, error: errMsg } }); } catch { /* ignore */ }
    throw e;
  } finally {
    try { await agent.close(); } catch { /* ignore */ }
  }

  // 4. 更新 provider_session_id（新 session 首次拿到 id；续 session 一般不变但也更新）
  if (newProviderSid && newProviderSid !== manifest.provider_session_id) {
    updateSessionManifest(manifest.id, { provider_session_id: newProviderSid });
  }

  // 5. 追加 assistant 消息
  const assistantMsg: ChatMessage = {
    role: "assistant",
    content: assistantText,
    ts: new Date().toISOString(),
  };
  if (usage) assistantMsg.usage = usage;
  appendMessage(manifest.id, assistantMsg);

  // 6. 完整消息到达后推 complete 事件（UI 可用此校准 delta 累积）
  try { emit({ type: "chat:complete", payload: { sessionId: sid, message: assistantMsg } }); } catch { /* ignore */ }

  return { session_id: manifest.id, message: assistantMsg };
}

// loopback host 判定：用于 /api/fs/list 等本机敏感接口的来源校验
function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost") return true;
  if (h === "127.0.0.1" || h.startsWith("127.")) return true;
  if (h === "::1" || h === "[::1]") return true;
  return false;
}
