import { existsSync, mkdirSync, writeFileSync, appendFileSync } from "fs";
import { join, resolve, sep } from "path";
import { getPhaseIndex } from "../core/artifacts";
import { VERSION } from "../index";
import { initDb, getTask, createTask, listTasks, getTaskLogs, getSubTasks, updateTask } from "../core/db";
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
const TASK_ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23567";

function genTaskId(len = 8): string {
  let id = "";
  for (let i = 0; i < len; i++) {
    id += TASK_ID_ALPHABET[Math.floor(Math.random() * TASK_ID_ALPHABET.length)];
  }
  return id;
}

function generateUniqueTaskId(): string {
  // 28^8 ≈ 3.7e11，撞概率极低；做 10 次重试足够。
  for (let i = 0; i < 10; i++) {
    const id = genTaskId();
    if (!getTask(id)) return id;
  }
  throw new Error("无法生成唯一 task ID（重试 10 次仍冲突）");
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
      const body = await req.json() as {
        title?: string;
        requirement?: string;
        workflow?: string;
        /** 兼容老调用：可选传入；不传则后端生成。 */
        reqId?: string;
      };

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

      // ID 策略：优先 body.reqId 前 8 字符（老接口兼容），否则生成唯一短 ID
      let taskId: string;
      if (body.reqId) {
        taskId = body.reqId.slice(0, 8);
        if (getTask(taskId)) return error(`Task ID 已存在：${taskId}`, 409);
      } else {
        taskId = generateUniqueTaskId();
      }
      const title = body.title?.trim() || taskId;
      const requirement = body.requirement?.trim();

      let extra: Record<string, unknown> = {};
      if (typeof wf.setup_func === "function") {
        try {
          extra = wf.setup_func({
            reqId: body.reqId ?? taskId,
            title,
            taskId,
            requirement,
          }) ?? {};
        } catch (e: unknown) {
          return error(`setup_func failed: ${e instanceof Error ? e.message : String(e)}`, 500);
        }
      }
      // 如果工作流的 setup_func 没把 requirement 塞进 extra，框架自动塞一份，
      // 让 task.requirement 字段可被前端展示和工作流读取。
      if (requirement && extra["requirement"] === undefined) {
        extra["requirement"] = requirement;
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
        workflowSnapshot: snapshotWorkflow(wf),
      });

      // 初始化任务 workspace（若工作流声明了 template 则复制）
      try {
        ensureTaskWorkspace(taskId, workflowName, wf.workspace);
      } catch (e: unknown) {
        // workspace 初始化失败不阻塞任务（用户可能手动创建）
        console.warn("ensureTaskWorkspace 失败：", e instanceof Error ? e.message : e);
      }

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
      // 附加 workspace 路径（方便 UI 展示 / 用户 cd 过去）
      return json({ ...task, workspace: getTaskWorkspace(taskIdMatch) });
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

    // POST /api/tasks/:id/restart — 把未完成的任务从当前阶段重新执行（dangling 救援用）
    const restartMatch = extractParam(path, /^\/api\/tasks\/([\w.\-]+)\/restart$/);
    if (method === "POST" && restartMatch) {
      const taskId = restartMatch;
      const task = getTask(taskId);
      if (!task) return error("Task not found", 404);

      // 终态不允许重启（用 clone 不过这里没实现）
      const wf = getWorkflow(task.workflow);
      const terminalStates = new Set(["done", "cancelled"]);
      if (wf) for (const s of wf.terminal_states ?? []) terminalStates.add(s);
      if (terminalStates.has(task.status)) {
        return error(`Task 已是终态（${task.status}），无法重启；请新建任务`);
      }

      // 从 status 提取 phase 名（running_X / pending_X / awaiting_X / X_rejected）
      const m = task.status.match(/^(?:running_|pending_|awaiting_)(.+)$/);
      const phase = m ? m[1] : null;
      if (!phase) {
        return error(`无法从状态 ${task.status} 推断 phase 名，重启失败`);
      }

      // 验证 phase 在 workflow 里存在
      if (wf) {
        const phaseDef = wf.phases.find((p) => {
          if (isParallelPhase(p)) return p.parallel.name === phase;
          return (p as { name: string }).name === phase;
        });
        if (!phaseDef) return error(`workflow 里没有阶段 ${phase}`);
      }

      // 直接改 status + 清掉 dangling/pending_question；绕过状态机，因为是用户级救援
      updateTask(taskId, {
        status: `pending_${phase}`,
        dangling: false,
        pending_question: "",
      });
      log.info("任务被用户手动重启 [task=%s phase=%s 原状态=%s]", taskId, phase, task.status);
      emit({ type: "task:updated", payload: { task: getTask(taskId)!, fields: ["status"] } });

      // 异步触发执行
      executePhase(taskId, phase).catch(() => {});

      return json({ ok: true, phase, from: task.status });
    }

    // POST /api/tasks/:id/answer — 用户回答 agent 的 ask_user 提问
    const answerMatch = extractParam(path, /^\/api\/tasks\/([\w.\-]+)\/answer$/);
    if (method === "POST" && answerMatch) {
      const body = await req.json() as { text?: string };
      const text = body.text?.trim() ?? "";
      if (!text) return error("answer text is required");
      const { answerPending, hasPending } = await import("../agents/pending-questions");
      if (!hasPending(answerMatch)) return error("没有待回答的问题");
      const ok = answerPending(answerMatch, text);
      if (!ok) return error("无法回答（pending 已被消费？）");
      return json({ ok: true });
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
