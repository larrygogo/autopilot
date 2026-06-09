import { existsSync, mkdirSync, writeFileSync, appendFileSync } from "fs";
import { readdir } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { join, resolve, sep, dirname, parse as parsePath } from "path";
import {
  signJwt,
  verifyJwt,
  extractJwtFromCookie,
  makeSessionCookie,
  hasAnyUser,
  verifyUser,
  getUserById,
  createUser,
  listUsers,
  type User,
} from "../core/auth";
import { getPhaseIndex } from "../core/artifacts";
import { VERSION, GIT_SHA, STARTED_AT_ISO } from "../index";
import { initDb, getDb, getTask, createTask, listTasks, getTaskLogs, getSubTasks, updateTask, listRootTasksByRequirementIds } from "../core/db";
import { log } from "../core/logger";
import { snapshotWorkflow } from "../core/manifest";
import {
  createSession,
  appendMessage,
  readManifest as readSessionManifest,
  readMessages as readSessionMessages,
  updateManifest as updateSessionManifest,
  type ChatMessage,
} from "../core/sessions";
import { createAgent } from "../agents/registry";
import { DEFAULT_AGENT } from "../core/agent-defaults";
import type { ListTasksFilters } from "../core/db";
import { transition, canTransition } from "../core/state-machine";
import { executePhase } from "../core/runner";
import { startTaskFromTemplate, StartTaskError } from "../core/task-factory";
import { cascadeDeleteTask, deleteRequirementWithTasks, DeleteTaskError } from "../core/task-delete";
import { cancelTaskAction, restartTaskAction, answerTaskAction, decideTaskAction, releaseTaskSandboxAction, cancelRequirementWithTasks, TaskActionError } from "./task-actions";
import { getWorkflowView, computeWorkflowGraph, WorkflowViewError } from "./workflow-views";
import { listWorkspaces, getWorkspaceById, getTopWorkspaceForProject } from "../core/workspaces";
import { listSubPrs } from "../core/requirement-sub-prs";
import {
  listRequirements,
  getRequirementById,
  createRequirement,
  updateRequirement,
  setRequirementStatus,
  nextRequirementId,
  finishClarification,
} from "../core/requirements";
import {
  listComments,
  createComment,
  getCommentById,
  resolveComment,
  nextCommentId,
} from "../core/requirement-comments";
import type { Requirement } from "../core/requirements";
import { listSpecRevisionsByRequirement } from "../core/spec-revisions";
import { runClarifierRound } from "./requirement-clarifier";
import { getRound } from "./clarifier-progress";
import { handleMcpHttp } from "../agents/mcp-server";
import { getMcpToken } from "./mcp-runtime";
import { buildAutopilotTools, buildWorkflowAgentTools } from "../agents/tools";
import type { RegisteredTool } from "../agents/mcp-tools";

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
  type PhaseEntryInput,
} from "../core/registry";
import {
  listWorkflowsInDb,
  getWorkflowFromDb,
  updateDbWorkflow,
  deleteDbWorkflow,
} from "../core/workflows";
import {
  loadDaemonConfig,
  saveDaemonConfig,
  loadProviders,
  type ProviderName,
} from "../core/config";
import type { Agent } from "../agents/agent";
import { loadApiToken, previewApiToken, saveApiToken, deleteApiToken, generateApiToken } from "../core/api-token";
import {
  ensureTaskSandbox,
  getTaskSandbox,
  listSandboxDir,
  readSandboxFile,
  resolveSandboxPath,
  spawnSandboxZip,
  sandboxSize,
} from "../core/sandbox";
import { listPhaseLogs, readPhaseLog, readTaskEvents, listAgentCalls, getAgentCall } from "../core/task-logs";
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
// mutable —— daemon 启动时按监听 host 追加局域网 IP（开 0.0.0.0 模式）。
const ALLOWED_ORIGINS: string[] = (process.env.AUTOPILOT_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** 追加额外的 origin 到 allowlist（daemon 启动时调）。已存在则去重。 */
export function extendAllowedOrigins(origins: string[]): void {
  for (const o of origins) {
    if (o && !ALLOWED_ORIGINS.includes(o)) ALLOWED_ORIGINS.push(o);
  }
}

/**
 * 一个 host 字符串是否会真的开放到本机以外（0.0.0.0 / :: / 具体外部 IP）。
 * 用于：daemon 启动安全检查 + UI 切换前的 token 强制检查。
 */
export function isExposedHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "127.0.0.1" || h.startsWith("127.") || h === "localhost") return false;
  if (h === "::1" || h === "[::1]") return false;
  return true;
}

/**
 * 探测本机所有非 loopback、非 internal 的 IPv4 地址。
 * 用于 daemon 启动时自动把局域网 IP 加进 CORS allowlist，
 * 也用于 GET /api/daemon/listen 给 UI 展示当前可访问的 LAN 地址。
 */
export function detectLanIPv4(): string[] {
  const { networkInterfaces } = require("os") as typeof import("os");
  const out: string[] = [];
  for (const ifaces of Object.values(networkInterfaces() ?? {})) {
    if (!ifaces) continue;
    for (const i of ifaces) {
      if (i.internal) continue;
      const fam = (i as { family: string | number }).family;
      if (fam !== "IPv4" && fam !== 4) continue;
      out.push(i.address);
    }
  }
  return out;
}

// Token 鉴权：env AUTOPILOT_API_TOKEN > file ~/.autopilot/runtime/api-token > 空。
// 设置后所有 /api/* 请求需带 `Authorization: Bearer <token>` 或 `X-Autopilot-Token: <token>`，
// 本机 loopback 来源（127.x / ::1）即便有 token 也直接放行（本地浏览器无需改造）。
type TokenSource = "env" | "file" | "none";
let API_TOKEN: string = "";
let API_TOKEN_SOURCE: TokenSource = "none";

/** daemon 启动时 / token 轮换后调，刷新当前 token。 */
export function reloadApiToken(): void {
  const envToken = process.env.AUTOPILOT_API_TOKEN ?? "";
  if (envToken) {
    API_TOKEN = envToken;
    API_TOKEN_SOURCE = "env";
    return;
  }
  const fileToken = loadApiToken();
  if (fileToken) {
    API_TOKEN = fileToken;
    API_TOKEN_SOURCE = "file";
    return;
  }
  API_TOKEN = "";
  API_TOKEN_SOURCE = "none";
}

// 启动时初始化一次（routes.ts 加载即生效）
reloadApiToken();

export interface ApiTokenState {
  is_set: boolean;
  /** env / file / none —— UI 用此判断"是否能在 UI 改"（env 来源时只读） */
  source: TokenSource;
  /** 已设时给一个 'abcd***wxyz' 形式预览，不暴露完整 token */
  preview: string | null;
}

/** 返回当前 token 状态（不含明文），用于 GET /api/daemon/listen 等。 */
export function getApiTokenState(): ApiTokenState {
  return {
    is_set: API_TOKEN.length > 0,
    source: API_TOKEN_SOURCE,
    preview: API_TOKEN ? previewApiToken(API_TOKEN) : null,
  };
}

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

/**
 * 把 IPv4-mapped IPv6（::ffff:127.0.0.1）规范化回 IPv4 形式，方便 loopback 判定。
 * 其他形式原样返回。
 */
function normalizeIp(addr: string): string {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr);
  return m ? m[1] : addr;
}

/**
 * 判定 socket 远端是否本机 loopback。
 * 用于 token 鉴权豁免：开 0.0.0.0 时本机浏览器（127.0.0.1 来源）依然免 token，
 * 只对真正从外部网卡进来的请求要 token。
 *
 * 不信任 Host header（可伪造）；不支持 X-Forwarded-For（autopilot 不应放反代后）。
 */
function isLoopbackSocket(server: import("bun").Server<undefined> | undefined, req: Request): boolean {
  if (!server) return false;
  try {
    const info = server.requestIP(req);
    if (!info) return false;
    const addr = normalizeIp(info.address.toLowerCase());
    if (addr === "127.0.0.1" || addr.startsWith("127.")) return true;
    if (addr === "::1") return true;
    return false;
  } catch {
    return false;
  }
}

/** 常量时间字符串比较，避免 token 逐字符早退泄露的时序侧信道（SEC-3）。 */
export function tokenEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  // 长度不等 timingSafeEqual 会抛；长度本身非高度机密，直接早退可接受。
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function checkAuth(req: Request, server?: import("bun").Server<undefined>): boolean {
  if (!API_TOKEN) return true;
  if (isLoopbackSocket(server, req)) return true;
  const header = req.headers.get("authorization") ?? "";
  if (header.startsWith("Bearer ") && tokenEquals(header.slice(7), API_TOKEN)) return true;
  const xToken = req.headers.get("x-autopilot-token");
  if (xToken && tokenEquals(xToken, API_TOKEN)) return true;
  // URL query string fallback：浏览器 WebSocket API 不能自定义 header，
  // 只能把 token 塞 URL；HTTP 走 fetch 通常用 header，但 query 路径也开着兜底。
  try {
    const url = new URL(req.url);
    const q = url.searchParams.get("token");
    if (q && tokenEquals(q, API_TOKEN)) return true;
  } catch { /* ignore URL parse 失败 */ }
  return false;
}

/** 仅 WebSocket upgrade 路径使用 —— 不复用 checkAuth 是为了避免 server 参数变成可选时静默通过。 */
export function checkWebSocketAuth(req: Request, server: import("bun").Server<undefined>): boolean {
  return checkAuth(req, server);
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

// ──────────────────────────────────────────────
// gate 决断辅助
// ──────────────────────────────────────────────

export function phaseIndex(wf: ReturnType<typeof getWorkflow>, phase: string): number {
  if (!wf) return -1;
  return getPhaseIndex(wf, phase);
}

export function parseDecisionCounts(raw: unknown): Record<string, number> {
  if (typeof raw !== "string") return {};
  try {
    return JSON.parse(raw) as Record<string, number>;
  } catch {
    return {};
  }
}

export function renderDecisionMd(d: { phase: string; decision: string; note: string; ts: string; by: string }): string {
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

export async function handleRequest(req: Request, server?: import("bun").Server<undefined>): Promise<Response> {
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
    // MCP 客户端永远是本机 claude 子进程（URL 回退 127.0.0.1）；即便 daemon 绑 0.0.0.0，
    // 也不该把可触发 start_task/cancel_task 的 /mcp 暴露到局域网。按请求来源 socket IP 判定
    // （不可伪造、不看 Host 头），与 /api/fs/list 同款 loopback 闸（SEC-2）。
    if (!isLoopbackSocket(server, req)) {
      return error("mcp-disabled-on-public-bind", 403);
    }
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

  // ── /api/auth/* 路由（公开，无需 API token）──────────────────────────────
  if (path.startsWith("/api/auth/")) {
    const authResult = await handleAuthRoute(req, method, path, json, error, cors);
    if (authResult) return authResult;
  }

  // Token 鉴权（仅在 /api/* 上生效，静态资源不需要）
  // 回落策略：API token 不通时再检查 JWT cookie（Web UI 登录后用此方式鉴权）
  if (path.startsWith("/api/") && !checkAuth(req, server)) {
    const jwtToken = extractJwtFromCookie(req);
    if (jwtToken) {
      try {
        await verifyJwt(jwtToken);
        // JWT 有效，放行
      } catch {
        return error("Unauthorized", 401);
      }
    } else {
      return error("Unauthorized", 401);
    }
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
        git_sha: GIT_SHA,
        started_at_iso: STARTED_AT_ISO,
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        pid: process.pid,
        taskCounts,
      };
      return json(status);
    }

    // GET /api/daemon/log 已迁到 WS RPC: daemon.log

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
        /** CLI 传入 workspace 别名，daemon 解析为 workspace_id 透传给 setup_func */
        workspace_alias?: string;
        /** 额外工作流参数（如 workspace_id），透传给 setup_func */
        [key: string]: unknown;
      };
      // 如果 caller 传了 workspace_alias，解析为 workspace_id（不覆盖已有 workspace_id）
      // P3 待修：alias 现在 project 内唯一，全局可能多个；目前取首个匹配。
      if (body.workspace_alias && !body.workspace_id) {
        const workspace = listWorkspaces({ includeSubmodules: true }).find(
          (c) => c.alias === body.workspace_alias,
        );
        if (!workspace) return error(`找不到别名为 "${body.workspace_alias}" 的 workspace`, 404);
        body.workspace_id = workspace.id;
      }
      try {
        const task = await startTaskFromTemplate(body);
        return json(task, 201);
      } catch (e: unknown) {
        if (e instanceof StartTaskError) return error(e.message, e.status);
        return error(e instanceof Error ? e.message : String(e), 500);
      }
    }

    // /api/schedules/* HTTP endpoints 已全部迁到 WS RPC：
    //   GET    /api/schedules            → schedules.list
    //   POST   /api/schedules            → schedules.create
    //   GET    /api/schedules/:id        → schedules.get
    //   PATCH  /api/schedules/:id        → schedules.update
    //   DELETE /api/schedules/:id        → schedules.delete
    //   POST   /api/schedules/:id/run-now → schedules.runNow

    // /api/setup/status 已迁到 WS RPC: setup.status
    // POST /api/setup/* 已迁到 WS RPC（setup.saveProviders / saveAgents / saveWorkspaces / setup.dismiss）

    // ─────────── 文件系统浏览 ───────────

    // GET /api/fs/list?path=<absolute>&show_hidden=1
    if (method === "GET" && path === "/api/fs/list") {
      // 防局域网泄露本机文件树：按「请求来源 socket IP」判断，而非绑定地址。
      // 本机（loopback）访问放行——即使 daemon 绑 0.0.0.0；只挡真正从局域网远程
      // 发来的请求。与 token 鉴权同款 isLoopbackSocket 模型一致（socket peer IP
      // 由内核给出，不可伪造、不看 Host 头）。
      if (!isLoopbackSocket(server, req)) {
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
      // 大目录截断：客户在 web 误点 /usr/lib 或 C:\Windows\System32（万级
      // entries）会让 daemon 卡几秒做 stat + 序列化大 JSON。加上限保护
      // UX + daemon 稳定性。
      const MAX_ENTRIES = 2000;
      let truncated = false;
      for (const ent of rawEntries) {
        // 跳过隐藏文件（以 . 开头）
        if (!showHidden && ent.name.startsWith(".")) continue;
        if (entries.length >= MAX_ENTRIES) {
          truncated = true;
          break;
        }
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

      return json({ current_path: targetPath, parent_path: parentPath, entries, truncated });
    }

    // /api/projects/* HTTP endpoints 已全部迁到 WS RPC：
    //   GET    /api/projects                    → projects.list
    //   POST   /api/projects                    → projects.create
    //   GET    /api/projects/:id                → projects.get
    //   PUT    /api/projects/:id                → projects.update
    //   DELETE /api/projects/:id                → projects.delete
    //   GET    /api/projects/:id/workspaces      → projects.workspaces
    //   POST   /api/projects/:id/workspaces      → projects.addWorkspace
    //   GET    /api/projects/:id/requirements   → projects.requirements

    // ─────────── Workspaces（主路由已迁 WS RPC：workspaces.list/get/create/update/delete/listSubmodules/healthcheck/rediscoverSubmodules） ───────────
    // 旧 /api/repos/* HTTP 路由已在 Phase 1 清理删除（spec §3.1）。所有 workspace 操作走 WS RPC。

    // ─────────── Requirements ───────────

    // GET /api/requirements
    if (method === "GET" && path === "/api/requirements") {
      const workspaceId = url.searchParams.get("workspace_id") ?? undefined;
      const projectId = url.searchParams.get("project_id") ?? undefined;
      const status = url.searchParams.get("status") ?? undefined;
      return json({
        requirements: listRequirements({ workspace_id: workspaceId, project_id: projectId, status }),
      });
    }

    // REMOVED: POST /api/requirements/extract → WS RPC method "requirements.extract"

    // POST /api/requirements
    if (method === "POST" && path === "/api/requirements") {
      const body = (await req.json()) as {
        project_id?: string;
        workspace_id?: string | null;
        title?: string;
        spec_md?: string;
        chat_session_id?: string | null;
      };
      let workspaceId = body.workspace_id ?? null;
      if (!body.title?.trim()) {
        return error("title 必填");
      }
      // 必须能确定 project_id：要么调用方直接传，要么从 workspace 反查
      let projectId = body.project_id?.trim();
      if (workspaceId) {
        const ws = getWorkspaceById(workspaceId);
        if (!ws) return error("workspace not found", 404);
        projectId = projectId ?? ws.project_id;
      }
      if (!projectId) {
        return error("project_id 必填（或提供 workspace_id 由 daemon 反查）");
      }
      // 强制项目须关联工作区；项目:工作区 1:1 → 未显式指定时自动派生，免手动绑定
      const topWs = getTopWorkspaceForProject(projectId);
      if (!topWs) {
        return error("项目未关联工作区，请先添加工作区再创建需求");
      }
      if (!workspaceId) workspaceId = topWs.id;
      const id = nextRequirementId();
      try {
        createRequirement({
          id,
          project_id: projectId,
          workspace_id: workspaceId,
          title: body.title.trim(),
          spec_md: body.spec_md ?? "",
          chat_session_id: body.chat_session_id ?? null,
        });
        // 自动进入澄清流程（触发 requirement-clarifier 后台生成问题）
        const clarifying = setRequirementStatus(id, "clarifying");
        return json({ requirement: clarifying }, 201);
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
        return json({ requirement: setRequirementStatus(reqTransitionMatch, body.to.trim()) });
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
      if (!r.workspace_id) return error("请先关联工作区再入队");
      if (!(r.spec_md ?? "").trim()) {
        return error("需求规约为空，请先完成澄清或手动填写规约");
      }
      // 仅置 queued；调度器（src/daemon/requirement-scheduler.ts）会监听 status 变化触发创建 task
      try {
        return json({ requirement: setRequirementStatus(id, "queued") });
      } catch (e: unknown) {
        return error((e as Error).message);
      }
    }


    // POST /api/requirements/:id/cancel
    const reqCancelMatch = extractParam(path, /^\/api\/requirements\/([\w-]+)\/cancel$/);
    if (reqCancelMatch && method === "POST") {
      if (!getRequirementById(reqCancelMatch)) return error("requirement not found", 404);
      try {
        return json(cancelRequirementWithTasks(reqCancelMatch));
      } catch (e: unknown) {
        return error((e as Error).message);
      }
    }

    // GET /api/requirements/:id/sub-prs 已迁 WS RPC requirements.subPrs

    // POST /api/requirements/:id/finish-clarification
    const finishMatch = path.match(/^\/api\/requirements\/([\w.\-]+)\/finish-clarification$/);
    if (method === "POST" && finishMatch) {
      const id = decodeURIComponent(finishMatch[1]);
      const req2 = getRequirementById(id);
      if (!req2) return error("requirement not found", 404);
      finishClarification(id);
      const updated = getRequirementById(id);
      return json({ requirement: updated });
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

    // ─────────── Comments（评论线程：question / feedback / handoff） ───────────

    // POST /api/requirements/:reqId/comments/:cid/resolve
    const reqCidResolveMatch = path.match(/^\/api\/requirements\/([\w-]+)\/comments\/([\w-]+)\/resolve$/);
    if (method === "POST" && reqCidResolveMatch) {
      const [, reqId, cid] = reqCidResolveMatch;
      if (!getRequirementById(reqId)) return error("requirement not found", 404);
      const c = getCommentById(cid);
      if (!c) return error("comment not found", 404);
      resolveComment(cid);
      // 当 question 全部 resolved 时通知 clarifier 决定是否继续追问
      if (c.kind === "question") {
        const allQuestions = listComments(reqId, { kind: "question" });
        if (allQuestions.length > 0 && allQuestions.every(q => q.status === "resolved")) {
          emit({ type: "requirement:all-questions-resolved", payload: { id: reqId } });
        }
      }
      return json({ ok: true });
    }

    // GET /api/requirements/:reqId/comments?kind=&status=
    const reqCommentsMatch = extractParam(path, /^\/api\/requirements\/([\w-]+)\/comments$/);
    if (method === "GET" && reqCommentsMatch) {
      if (!getRequirementById(reqCommentsMatch)) return error("requirement not found", 404);
      const kind = url.searchParams.get("kind") as ("question" | "feedback" | "handoff" | null);
      const status = url.searchParams.get("status") as ("open" | "resolved" | null);
      return json({
        comments: listComments(reqCommentsMatch, {
          ...(kind ? { kind } : {}),
          ...(status ? { status } : {}),
        }),
      });
    }

    // POST /api/requirements/:reqId/comments
    if (method === "POST" && reqCommentsMatch) {
      const reqId = reqCommentsMatch;
      const r = getRequirementById(reqId);
      if (!r) return error("requirement not found", 404);
      const body = (await req.json()) as {
        kind?: "question" | "feedback" | "handoff";
        from_role?: "agent" | "user" | "github";
        body?: string;
        parent_id?: string;
        suggestions?: string[];
        github_review_id?: string;
      };
      if (!body.kind) return error("kind 必填");
      if (!body.from_role) return error("from_role 必填");
      if (!body.body?.trim()) return error("body 必填");
      const id = nextCommentId();
      const comment = createComment({
        id,
        requirement_id: reqId,
        kind: body.kind,
        from_role: body.from_role,
        body: body.body.trim(),
        parent_id: body.parent_id ?? null,
        suggestions: body.suggestions,
        github_review_id: body.github_review_id ?? null,
      });
      // feedback 注入：若 requirement 当前 awaiting_review，触发 fix_revision
      // （原 inject_feedback endpoint 的行为，spec §3.2 统一进 comments.add）
      if (body.kind === "feedback" && r.status === "awaiting_review") {
        try {
          setRequirementStatus(reqId, "fix_revision");
        } catch (e: unknown) {
          log.warn("comments.add(feedback) 触发 fix_revision 失败（反馈已写入）[req=%s err=%s]", reqId, (e as Error).message);
        }
      }
      return json({ comment }, 201);
    }

    // GET|PUT|DELETE /api/requirements/:id
    const reqDetailMatch = extractParam(path, /^\/api\/requirements\/([\w-]+)$/);
    if (reqDetailMatch) {
      const r = getRequirementById(reqDetailMatch);
      if (!r) return error("requirement not found", 404);

      if (method === "GET") {
        return json({ requirement: r, comments: listComments(reqDetailMatch) });
      }
      if (method === "PUT") {
        const body = (await req.json()) as {
          title?: string;
          spec_md?: string;
          workspace_id?: string | null;
          chat_session_id?: string | null;
        };
        if (body.title !== undefined && !body.title.trim()) {
          return error("title 不能为空");
        }
        if (body.workspace_id !== undefined && body.workspace_id !== null) {
          if (!getWorkspaceById(body.workspace_id)) return error("workspace not found", 404);
        }
        return json({ requirement: updateRequirement(reqDetailMatch, body) });
      }
      if (method === "DELETE") {
        // 删一件工作 = 需求 + 其名下全部任务（含运行中）。先 best-effort 停 agent 再强删，
        // 与 WS RPC requirements.delete / 项目级联删除同一语义，不留孤儿任务。
        for (const t of listRootTasksByRequirementIds([reqDetailMatch])) {
          try {
            cancelTaskAction(t.id);
          } catch {
            /* 已终态 / 不存在：忽略，强删兜底 */
          }
        }
        const { deletedTasks } = deleteRequirementWithTasks(reqDetailMatch);
        return json({ ok: true, deletedTasks: deletedTasks.length });
      }
    }

    // GET /api/tasks/:id
    const taskIdMatch = extractParam(path, /^\/api\/tasks\/([\w.\-]+)$/);
    if (method === "GET" && taskIdMatch) {
      const task = getTask(taskIdMatch);
      if (!task) return error("Task not found", 404);
      // 附加 sandbox 路径（方便 UI 展示 / 用户 cd 过去）
      return json({ ...task, workspace: getTaskSandbox(taskIdMatch) });
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

    // POST /api/tasks/:id/send_prompt — 运行中 task 追加 prompt（spec §3.8）
    const sendPromptMatch = extractParam(path, /^\/api\/tasks\/([\w.\-]+)\/send_prompt$/);
    if (method === "POST" && sendPromptMatch) {
      const body = (await req.json()) as { prompt?: string };
      const prompt = typeof body.prompt === "string" ? body.prompt : "";
      if (!prompt.trim()) return error("prompt 必填");
      const { sendPromptToTask } = await import("../core/task-send-prompt");
      const result = sendPromptToTask(sendPromptMatch, prompt, { source: "user" });
      if (!result.accepted) {
        if (result.reason === "TASK_TERMINAL") return error("TASK_TERMINAL: task 已是终态，无法接受新 prompt", 409);
        if (result.reason === "NO_PROMPT_TARGET") return error("task 不存在", 404);
        return error(result.reason ?? "rejected", 400);
      }
      return json({ mode: result.mode, accepted: true });
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
      try {
        return json(decideTaskAction(decideMatch, body.decision, body.note ?? "", {
          phaseIndex, parseDecisionCounts, renderDecisionMd,
        }));
      } catch (e: unknown) {
        if (e instanceof TaskActionError) return error(e.message, e.status);
        return error(e instanceof Error ? e.message : String(e), 500);
      }
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

    // GET /api/tasks/:id/sandbox/tree?path=<relative>
    const wsTreeMatch = extractParam(path, /^\/api\/tasks\/([\w.\-]+)\/sandbox\/tree$/);
    if (method === "GET" && wsTreeMatch) {
      const relPath = url.searchParams.get("path") ?? "";
      try {
        const entries = listSandboxDir(wsTreeMatch, relPath);
        return json({ path: relPath, entries });
      } catch (e: unknown) {
        return error(e instanceof Error ? e.message : String(e), 400);
      }
    }

    // GET /api/tasks/:id/sandbox/file?path=<relative>
    const wsFileMatch = extractParam(path, /^\/api\/tasks\/([\w.\-]+)\/sandbox\/file$/);
    if (method === "GET" && wsFileMatch) {
      const relPath = url.searchParams.get("path") ?? "";
      if (!relPath) return error("path 参数必填", 400);
      try {
        const file = readSandboxFile(wsFileMatch, relPath);
        return json(file);
      } catch (e: unknown) {
        return error(e instanceof Error ? e.message : String(e), 400);
      }
    }

    // GET /api/tasks/:id/sandbox/download?path=<relative> —— 二进制原样下载单文件
    const wsDownloadMatch = extractParam(path, /^\/api\/tasks\/([\w.\-]+)\/sandbox\/download$/);
    if (method === "GET" && wsDownloadMatch) {
      const relPath = url.searchParams.get("path") ?? "";
      if (!relPath) return error("path 参数必填", 400);
      try {
        const abs = resolveSandboxPath(wsDownloadMatch, relPath);
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

    // GET /api/tasks/:id/sandbox/zip — 整个 sandbox 打包
    const wsZipMatch = extractParam(path, /^\/api\/tasks\/([\w.\-]+)\/sandbox\/zip$/);
    if (method === "GET" && wsZipMatch) {
      try {
        const proc = spawnSandboxZip(wsZipMatch);
        return new Response(proc.stdout as ReadableStream, {
          headers: {
            "Content-Type": "application/zip",
            "Content-Disposition": `attachment; filename="sandbox-${wsZipMatch}.zip"`,
            ...cors,
          },
        });
      } catch (e: unknown) {
        return error(e instanceof Error ? e.message : String(e), 500);
      }
    }

    // DELETE /api/tasks/:id/sandbox — 手动清理 sandbox
    const wsDeleteMatch = extractParam(path, /^\/api\/tasks\/([\w.\-]+)\/sandbox$/);
    if (method === "DELETE" && wsDeleteMatch) {
      try {
        const { removed } = releaseTaskSandboxAction(wsDeleteMatch);
        return json({ ok: true, removed });
      } catch (e: unknown) {
        if (e instanceof TaskActionError) return error(e.message, e.status);
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

    // GET /api/sandboxes/usage 已迁到 WS RPC: sandboxes.usage

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

    // /api/sessions/* HTTP endpoints 已迁到 WS RPC：
    //   GET    /api/sessions             → sessions.list
    //   GET    /api/sessions/:id         → sessions.get
    //   DELETE /api/sessions/:id         → sessions.delete
    //   GET    /api/sessions/:id/messages → sessions.get (响应含 messages)

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

    // /api/workflows/templates|author|author/save HTTP endpoints 已迁到 WS RPC：
    //   GET  /api/workflows/templates    → workflows.templates
    //   POST /api/workflows/author       → workflows.author
    //   POST /api/workflows/author/save  → workflows.saveAuthored

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
      try {
        return json(getWorkflowView(wfMatch));
      } catch (e: unknown) {
        if (e instanceof WorkflowViewError) return error(e.message, e.status);
        return error(e instanceof Error ? e.message : String(e), 500);
      }
    }

    // GET /api/workflows/:name/graph
    const graphMatch = extractParam(path, /^\/api\/workflows\/([\w.\-]+)\/graph$/);
    if (method === "GET" && graphMatch) {
      try {
        return json(computeWorkflowGraph(graphMatch));
      } catch (e: unknown) {
        if (e instanceof WorkflowViewError) return error(e.message, e.status);
        return error(e instanceof Error ? e.message : String(e), 500);
      }
    }

    // /api/config + /api/defaults HTTP endpoints 已迁到 WS RPC：
    //   GET  /api/config   → config.get
    //   PUT  /api/config   → config.save
    //   GET  /api/defaults → defaults.get
    //   PUT  /api/defaults → defaults.save

    // ── Daemon 监听配置 + API token ──
    // 改完 host/port 需要 daemon restart 才生效；token 改动立即生效（不必重启）。

    // GET /api/daemon/listen —— 当前监听配置 + token 状态 + 本机 LAN IP
    if (method === "GET" && path === "/api/daemon/listen") {
      const cfg = loadDaemonConfig();
      return json({
        host: cfg.host ?? "127.0.0.1",
        port: cfg.port ?? 6180,
        token: getApiTokenState(),
        lan_ips: detectLanIPv4(),
        mcp_note: "MCP /mcp 走独立 token（mcp-runtime 管理），不受此处控制",
      });
    }

    // PUT /api/daemon/listen —— 写 host/port 到 config.yaml；需 daemon restart 生效
    if (method === "PUT" && path === "/api/daemon/listen") {
      const body = (await req.json()) as { host?: string; port?: number };
      const host = typeof body.host === "string" ? body.host.trim() : undefined;
      const port = typeof body.port === "number" ? body.port : undefined;
      if (host !== undefined && host.length === 0) return error("host 不能为空");
      if (port !== undefined && (!Number.isInteger(port) || port <= 0 || port >= 65536)) {
        return error("port 必须是 1~65535 的整数");
      }
      // 暴露到外部时强制 token —— 否则裸奔
      if (host && isExposedHost(host) && !getApiTokenState().is_set) {
        return error("切到对外暴露的 host 前必须先设置 API token（POST /api/daemon/token/rotate）", 400);
      }
      try {
        saveDaemonConfig({ host, port });
        emit({ type: "config:updated", payload: {} });
        return json({ ok: true, host, port, restart_required: true });
      } catch (e: unknown) {
        return error(e instanceof Error ? e.message : String(e));
      }
    }

    // POST /api/daemon/token/rotate —— 生成新 token 写文件，返回一次性明文（Web 立即用此值替换 localStorage）
    if (method === "POST" && path === "/api/daemon/token/rotate") {
      // env 来源的 token 不允许在 UI 改 —— 它来自部署侧，UI 改了也不会生效
      if (getApiTokenState().source === "env") {
        return error("当前 token 来自环境变量 AUTOPILOT_API_TOKEN，无法在 UI 修改", 400);
      }
      try {
        const token = generateApiToken();
        saveApiToken(token);
        reloadApiToken();
        emit({ type: "config:updated", payload: {} });
        return json({ ok: true, token, state: getApiTokenState() });
      } catch (e: unknown) {
        return error(e instanceof Error ? e.message : String(e));
      }
    }

    // DELETE /api/daemon/token —— 清除文件 token；若当前 host 对外暴露则拒绝
    if (method === "DELETE" && path === "/api/daemon/token") {
      if (getApiTokenState().source === "env") {
        return error("当前 token 来自环境变量，无法在 UI 删除", 400);
      }
      const cfg = loadDaemonConfig();
      const currentHost = cfg.host ?? "127.0.0.1";
      if (isExposedHost(currentHost)) {
        return error("当前 host 为对外暴露状态，不能在保留暴露的同时删除 token；请先切回 127.0.0.1", 400);
      }
      try {
        deleteApiToken();
        reloadApiToken();
        emit({ type: "config:updated", payload: {} });
        return json({ ok: true, state: getApiTokenState() });
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

    // POST /api/workflows/import-bundle 已迁到 WS RPC: workflows.importBundle

    // GET /api/workflows/:name/ts — 读 workflow.ts 源码
    const tsReadMatch = extractParam(path, /^\/api\/workflows\/([\w.\-]+)\/ts$/);
    if (method === "GET" && tsReadMatch) {
      const content = getWorkflowTs(tsReadMatch);
      if (content === null) return error("workflow.ts not found", 404);
      return json({ content });
    }

    // POST /api/workflows/:name/dry-run — 不建 task / 不写 sandbox，直接调 agent.run 试跑 prompt
    // body: { agent?: InlineAgentConfig, prompt: string, timeout?: number(秒) }
    // 命名复用 agent 移除后：agent 字段接收一个内联配置对象（provider/model/system_prompt...），
    // 省略则用 DEFAULT_AGENT 兜底。
    const dryRunMatch = path.match(/^\/api\/workflows\/([\w.\-]+)\/dry-run$/);
    if (method === "POST" && dryRunMatch) {
      const body = (await req.json().catch(() => null)) as
        | { agent?: Record<string, unknown>; prompt?: string; timeout?: number }
        | null;
      if (!body || typeof body.prompt !== "string" || !body.prompt.trim()) {
        return error("prompt is required", 400);
      }
      let agent: Agent | null = null;
      try {
        agent = buildInlineDryRunAgent(body.agent);
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
      } finally {
        if (agent) { try { await agent.close(); } catch { /* ignore */ } }
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

    // PUT /api/workflows/:name/agents 已移除 —— 命名复用 agent 机制删除（Phase 3）。
    // phase 内联 agent 配置走 PUT /api/workflows/:name/yaml（整文件写）或 phases 编辑。

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

    // /api/providers/* HTTP endpoints 已全部迁到 WS RPC：
    //   GET /api/providers              → providers.list
    //   GET /api/providers/status       → providers.statusAll
    //   GET /api/providers/:name/status → providers.status
    //   GET /api/providers/:name/models → providers.models
    //   PUT /api/providers/:name        → providers.save

    // /api/agents/* HTTP endpoints 已全部迁到 WS RPC：
    //   GET  /api/agents          → agents.list
    //   GET  /api/agents/:name    → agents.get
    //   POST /api/agents          → agents.create
    //   PUT  /api/agents/:name    → agents.update
    //   DELETE /api/agents/:name  → agents.delete
    //   POST /api/agents/:name/dry-run → agents.dryRun
    // 客户端 (web/cli/tui) 已全部不再调用 HTTP 路径（`bun run coverage:rpc` 验证）。

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
// Auth 路由（公开，不过 API token 门）
// ──────────────────────────────────────────────

/**
 * 处理 /api/auth/* 请求。
 * 返回 Response 表示已处理；返回 null 表示路径不匹配，交由后续逻辑继续。
 */
async function handleAuthRoute(
  req: Request,
  method: string,
  path: string,
  json: (data: unknown, status?: number) => Response,
  error: (message: string, status?: number) => Response,
  cors: Record<string, string>,
): Promise<Response | null> {
  // POST /api/auth/login — 邮箱+密码登录，成功后 Set-Cookie JWT
  if (method === "POST" && path === "/api/auth/login") {
    if (!hasAnyUser()) {
      return json({ error: "未配置任何用户，auth 未启用" }, 400);
    }
    const body = await req.json().catch(() => null) as { email?: string; password?: string } | null;
    if (!body?.email || !body?.password) {
      return error("email 和 password 必填", 400);
    }
    const user = await verifyUser(body.email, body.password);
    if (!user) {
      return error("邮箱或密码错误", 401);
    }
    const token = await signJwt(user.id, user.email);
    const cookie = makeSessionCookie(token);
    return new Response(JSON.stringify({ ok: true, user }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": cookie,
        ...cors,
      },
    });
  }

  // POST /api/auth/logout — 清除 cookie
  if (method === "POST" && path === "/api/auth/logout") {
    const cookie = makeSessionCookie("", true);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": cookie,
        ...cors,
      },
    });
  }

  // GET /api/auth/me — 返回当前认证状态
  if (method === "GET" && path === "/api/auth/me") {
    const authEnabled = hasAnyUser();
    if (!authEnabled) {
      return json({ auth_enabled: false, user: null });
    }
    const token = extractJwtFromCookie(req);
    if (!token) {
      return json({ error: "未登录", code: "unauthenticated", auth_enabled: true }, 401);
    }
    try {
      const payload = await verifyJwt(token);
      const user = getUserById(payload.sub);
      if (!user) {
        return json({ error: "用户不存在", code: "unauthenticated", auth_enabled: true }, 401);
      }
      return json({ auth_enabled: true, user });
    } catch {
      return json({ error: "会话已过期，请重新登录", code: "unauthenticated", auth_enabled: true }, 401);
    }
  }

  // POST /api/auth/setup — 首次设置（仅在无用户时可用）
  if (method === "POST" && path === "/api/auth/setup") {
    if (hasAnyUser()) {
      return error("已存在用户，请通过登录进入", 400);
    }
    const body = await req.json().catch(() => null) as { email?: string; password?: string } | null;
    if (!body?.email || !body?.password) {
      return error("email 和 password 必填", 400);
    }
    if (body.password.length < 8) {
      return error("密码至少 8 位", 400);
    }
    try {
      const user = await createUser(body.email, body.password);
      const token = await signJwt(user.id, user.email);
      const cookie = makeSessionCookie(token);
      return new Response(JSON.stringify({ ok: true, user }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": cookie,
          ...cors,
        },
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return error(`创建用户失败：${msg}`, 400);
    }
  }

  // GET /api/auth/users — 列出所有用户（需要鉴权，在下方正常鉴权逻辑里处理）
  // 此处仅处理公开 auth 路由，匹配不到则返回 null
  return null;
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

/**
 * 默认 chat agent 名（命名复用 agent 机制移除后，chat 不再走命名 agent）。
 * 仅作为 session 元数据里的标识展示用。
 */
const DEFAULT_CHAT_AGENT_NAME = "assistant";

/**
 * 构造一个对话用 Agent 实例（不入缓存，调用方负责 close）。
 *
 * 命名复用 agent 机制移除后，chat 直接用一个硬编码默认配置（daemon 层基础设施）。
 * model 缺省时从 anthropic provider 的 default_model 补。
 */
function buildChatAgent(): Agent {
  const providers = loadProviders();
  const provider: ProviderName = "anthropic";
  return createAgent({
    name: DEFAULT_CHAT_AGENT_NAME,
    provider,
    model: providers[provider]?.default_model,
    max_turns: 20,
    permission_mode: "default",
    system_prompt:
      "你是 autopilot 的助理。可调用内建工具查询/操作任务、工作流、需求队列；" +
      "回答简洁直接，代码注释和说明用中文。",
  });
}

/**
 * 从内联 agent 配置对象构造一次性 dry-run Agent（不入缓存，调用方负责 close）。
 * 与 agentForPhase 同构的两层合并：inline 覆盖 DEFAULT_AGENT，model 缺省走
 * providers.<provider>.default_model。inline 省略时纯走 DEFAULT_AGENT。
 */
function buildInlineDryRunAgent(inline?: Record<string, unknown>): Agent {
  const merged: Record<string, unknown> = { ...DEFAULT_AGENT, ...(inline ?? {}) };
  const provider = (merged["provider"] as string | undefined) ?? DEFAULT_AGENT.provider;
  merged["provider"] = provider;
  if (!merged["model"]) {
    const providerCfg = loadProviders()[provider as ProviderName];
    if (providerCfg?.default_model) merged["model"] = providerCfg.default_model;
  }
  merged["name"] = (typeof merged["name"] === "string" && merged["name"]) ? merged["name"] : "dry-run";
  return createAgent(merged as Parameters<typeof createAgent>[0]);
}

async function handleChat(body: ChatRequestBody): Promise<ChatResponsePayload> {
  const message = body.message!;

  // 1. 定位/创建 session
  let manifest = body.session_id ? readSessionManifest(body.session_id) : null;
  if (body.session_id && !manifest) {
    throw new Error(`session 不存在：${body.session_id}`);
  }
  const agentName = manifest?.agent ?? body.agent ?? DEFAULT_CHAT_AGENT_NAME;
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
  const agent = buildChatAgent();
  let assistantText = "";
  let newProviderSid: string | undefined;
  let usage: ChatMessage["usage"];
  try {
    const result = await agent.chat(message, {
      providerSessionId: manifest.provider_session_id,
      enableTools: body.enable_tools !== false,  // 默认开工具
      onDelta: (delta) => {
        try { emit({ type: "chat:delta", payload: { sessionId: sid, delta } }); }
        catch (ee: unknown) { log.warn("emit chat:delta 失败 session=%s: %s", sid, (ee as Error)?.message ?? String(ee)); }
      },
    });
    assistantText = result.text;
    newProviderSid = result.providerSessionId;
    usage = result.usage;
  } catch (e: unknown) {
    const errMsg = e instanceof Error ? e.message : String(e);
    try { emit({ type: "chat:error", payload: { sessionId: sid, error: errMsg } }); }
    catch (ee: unknown) { log.warn("emit chat:error 失败 session=%s: %s", sid, (ee as Error)?.message ?? String(ee)); }
    throw e;
  } finally {
    try { await agent.close(); }
    catch (ee: unknown) { log.warn("agent.close 失败 session=%s: %s", sid, (ee as Error)?.message ?? String(ee)); }
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
  try { emit({ type: "chat:complete", payload: { sessionId: sid, message: assistantMsg } }); }
  catch (ee: unknown) { log.warn("emit chat:complete 失败 session=%s: %s", sid, (ee as Error)?.message ?? String(ee)); }

  return { session_id: manifest.id, message: assistantMsg };
}
