import type { NowCard } from "../lib/now-types";
import { rpcCall } from "../lib/ws-singleton";
import { RpcCallError, type CallOptions } from "../lib/ws-rpc-client";
import { getApiToken, shouldUseToken } from "../lib/api-token";

const BASE = "";

// ──────────────────────────────────────────────
// Comment → 旧 Question / RequirementFeedback 适配
// 仅用于让 UI 沿用旧字段名（agent_text / replies / RequirementFeedback.source）
// ──────────────────────────────────────────────

function commentToQuestionReply(c: { id: string; parent_id: string | null; from_role: string; body: string; created_at: number }): QuestionReply {
  return {
    id: c.id,
    question_id: c.parent_id ?? "",
    author_role: (c.from_role === "user" ? "user" : "agent"),
    text: c.body,
    created_at: c.created_at,
  };
}

function commentsToQuestions(all: Comment[]): Question[] {
  const tops = all.filter((c) => c.kind === "question" && c.parent_id === null);
  const repliesByParent = new Map<string, Comment[]>();
  for (const c of all) {
    if (c.kind === "question" && c.parent_id) {
      const arr = repliesByParent.get(c.parent_id) ?? [];
      arr.push(c);
      repliesByParent.set(c.parent_id, arr);
    }
  }
  return tops.map<Question>((q) => ({
    id: q.id,
    requirement_id: q.requirement_id,
    agent_text: q.body,
    suggestions: q.suggestions ?? [],
    status: q.status,
    created_at: q.created_at,
    resolved_at: q.resolved_at,
    replies: (repliesByParent.get(q.id) ?? []).map(commentToQuestionReply),
  }));
}

function commentsToFeedbacks(all: Comment[]): RequirementFeedback[] {
  let fakeId = 0;
  return all
    .filter((c) => c.kind === "feedback")
    .map<RequirementFeedback>((c) => ({
      // 旧 RequirementFeedback.id 是 INTEGER；comment.id 是字符串（fb-N 或 cmt-N）。
      // UI 仅用 id 做 React key，不用真整数。这里给递增整数避免 number 类型冲突。
      id: ++fakeId,
      requirement_id: c.requirement_id,
      source: c.from_role === "github" ? "github_review" : "manual",
      body: c.body,
      github_review_id: c.github_review_id,
      created_at: c.created_at,
    }));
}

/**
 * 内联 agent 配置（命名复用 agent 删除后的唯一形态）。
 * 与后端 core/agent-defaults.InlineAgentConfig 同构；phase 上挂 `agent` 字段，
 * dry-run 时也直接传这个对象，省略则后端走 DEFAULT_AGENT 兜底。
 */
export interface InlineAgentConfig {
  provider?: string;
  model?: string;
  max_turns?: number;
  permission_mode?: string;
  system_prompt?: string;
}

/** dry-run 时把临时 model/max_turns 覆盖合到内联配置上；全空则返回 undefined（让后端走默认）。 */
function mergeInlineAgent(
  agent: InlineAgentConfig | undefined,
  override: { model?: string; max_turns?: number },
): InlineAgentConfig | undefined {
  const merged: InlineAgentConfig = { ...(agent ?? {}) };
  if (override.model) merged.model = override.model;
  if (typeof override.max_turns === "number" && override.max_turns > 0) merged.max_turns = override.max_turns;
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** 返回需要塞进 fetch headers 的 token 字段；本机访问不需要 token 时返回空对象。 */
function authHeaders(): Record<string, string> {
  if (!shouldUseToken()) return {};
  const token = getApiToken();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

/**
 * 走 WS RPC 的薄包装 — 当前阶段只迁了少量 PoC method（见下方注释标记），
 * 其余 method 仍走 HTTP request()。两套并存，逐步迁移。
 *
 * 错误归一化：RpcCallError 转成普通 Error，文案包含 code，便于现有 UI 错误展示。
 */
async function requestRpc<T>(method: string, params?: unknown, opts?: CallOptions): Promise<T> {
  try {
    return await rpcCall<T>(method, params, opts);
  } catch (e: unknown) {
    if (e instanceof RpcCallError) {
      // DISCONNECTED 时给跟旧 fetch 失败一致的提示，让现有 daemon 失联横幅能复用判断
      if (e.code === "DISCONNECTED") {
        throw new Error("WebSocket 未连接（daemon 是否在运行？）");
      }
      throw new Error(`${e.code}: ${e.message}`);
    }
    throw e;
  }
}

/**
 * 标记新添加的 API endpoint（daemon 须是最新代码才有）。404 时提示重启 daemon。
 *
 * 严格 endpoint 匹配，不用 prefix 模糊匹配 —— 否则 `/api/requirements/<不存在的 id>` 这种
 * "endpoint 在但 resource 不存在"的 404 也会被误判为"daemon 旧版"，让用户看到误导提示。
 *
 * 顶层 collection endpoint 用 `(\?.*)?$` 允许 query string，但不匹配 `/:id` 子路径。
 */
const NEW_API_PATTERNS: RegExp[] = [
  // 带固定后缀的子路径 endpoint
  /^\/api\/workflows\/[\w.\-]+\/phases$/,
  /^\/api\/workflows\/[\w.\-]+\/sync-ts$/,
  /^\/api\/codebases\/[\w.\-]+\/submodules$/,
  /^\/api\/codebases\/[\w.\-]+\/rediscover-submodules$/,
  /^\/api\/requirements\/[\w.\-]+\/sub-prs$/,
  /^\/api\/requirements\/[\w.\-]+\/spec-revisions$/,
  /^\/api\/requirements\/[\w.\-]+\/clarifier-round$/,
  // 顶层 collection endpoint（list/create，不匹配 /:id 详情）
  /^\/api\/providers(\?.*)?$/,
  /^\/api\/schedules(\?.*)?$/,
  /^\/api\/defaults(\?.*)?$/,
  /^\/api\/codebases(\?.*)?$/,
  /^\/api\/fs\//,
  /^\/api\/requirements(\?.*)?$/,
  /^\/api\/projects(\?.*)?$/,
  /^\/api\/now\/cards(\?.*)?$/,
  /^\/api\/daemon\/listen(\?.*)?$/,
  /^\/api\/daemon\/token\/rotate$/,
  /^\/api\/daemon\/token$/,
];

export interface DaemonListenInfo {
  host: string;
  port: number;
  token: {
    is_set: boolean;
    source: "env" | "file" | "none";
    preview: string | null;
  };
  lan_ips: string[];
  mcp_note: string;
}

async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...opts,
      headers: { "Content-Type": "application/json", ...authHeaders(), ...opts?.headers },
    });
  } catch (e: unknown) {
    throw new Error(`网络请求失败：${(e as Error)?.message ?? String(e)}（daemon 是否在运行？）`);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    let msg = (body as any).error ?? `HTTP ${res.status}`;
    // 401 = token 缺失/错误。局域网访问场景下 token 在 localStorage 还没设。
    if (res.status === 401 && shouldUseToken()) {
      msg = "未授权（HTTP 401）：从局域网访问 daemon 需要设置 API token，请到「设置 → 客户端 Token」配置。";
    }
    // 特判：新 API 返回 404 往往意味着 daemon 跑的是旧代码
    if (res.status === 404 && NEW_API_PATTERNS.some((re) => re.test(path))) {
      msg = `接口 ${path} 不存在（HTTP 404）。请确认 daemon 已重启到最新版本：\n\n  autopilot daemon stop && autopilot daemon start`;
    }
    throw new Error(msg);
  }
  return res.json();
}

export const api = {
  // [WS-RPC] daemon.status — P3 第一批 PoC，已切到 WS
  getStatus: () => requestRpc<any>("daemon.status"),
  // [WS-RPC] tasks.list — P3 第一批 PoC
  listTasks: (filters?: Record<string, string>) => {
    const params: Record<string, unknown> = {};
    if (filters?.status) params.status = filters.status;
    if (filters?.workflow) params.workflow = filters.workflow;
    if (filters?.limit) params.limit = Number(filters.limit);
    return requestRpc<any[]>("tasks.list", params);
  },
  // [WS-RPC] tasks.get — P3 第一批 PoC
  getTask: (id: string) => requestRpc<any>("tasks.get", { id }),
  // [WS-RPC] tasks.start
  startTask: (body: { title?: string; requirement?: string; workflow?: string; reqId?: string }) =>
    requestRpc<any>("tasks.start", body),
  // [WS-RPC] tasks.cancel
  cancelTask: (id: string) => requestRpc<any>("tasks.cancel", { id }),
  // [WS-RPC] tasks.delete
  deleteTask: (id: string) =>
    requestRpc<{ ok: true; deleted: string[] }>("tasks.delete", { id }),
  // [WS-RPC] tasks.restart
  restartTask: (id: string) =>
    requestRpc<{ ok: true; phase: string; from: string }>("tasks.restart", { id }),
  // [WS-RPC] tasks.decide
  decideTask: (id: string, decision: "pass" | "reject" | "cancel", note?: string) =>
    requestRpc<{ from: string; to: string; decision: string; note: string }>(
      "tasks.decide", { id, decision, note },
    ),
  // [WS-RPC] tasks.answer
  answerTask: (id: string, text: string) =>
    requestRpc<{ ok: true }>("tasks.answer", { id, text }),
  // [WS-RPC] tasks.logs
  getTaskLogs: (id: string, limit = 100) =>
    requestRpc<any[]>("tasks.logs", { id, limit }),
  // [WS-RPC] tasks.phaseLogs
  getPhaseLogsList: (id: string) =>
    requestRpc<Array<{ phase: string; size: number; mtime: number }>>("tasks.phaseLogs", { id }),
  // [WS-RPC] tasks.phaseLog
  getPhaseLog: (id: string, phase: string, tail?: number) =>
    requestRpc<{ phase: string; content: string }>("tasks.phaseLog", { id, phase, tail }),
  // [WS-RPC] tasks.phaseEvents
  listTaskPhaseEvents: (id: string) =>
    requestRpc<{ events: TaskPhaseEvent[] }>("tasks.phaseEvents", { id }).then((r) => r.events),
  /** 同工作流历史 phase 耗时 P50 — 给"还要多久"参考 */
  // [WS-RPC] workflows.phaseStats
  getWorkflowPhaseStats: (workflow: string) =>
    requestRpc<{ stats: Record<string, { count: number; p50_ms: number }> }>(
      "workflows.phaseStats",
      { workflow },
    ).then((r) => r.stats),
  // [WS-RPC] tasks.outcome
  getTaskOutcome: (id: string) =>
    requestRpc<TaskOutcome>("tasks.outcome", { id }),
  // [WS-RPC] daemon.log
  getDaemonLog: (tail = 500) =>
    requestRpc<{ path: string | null; content: string }>("daemon.log", { tail }),
  // [WS-RPC] tasks.agentCalls
  listAgentCalls: (id: string) =>
    requestRpc<AgentCallSummary[]>("tasks.agentCalls", { id }),
  // [WS-RPC] tasks.agentCall
  getAgentCall: (id: string, seq: number) =>
    requestRpc<AgentCallRecord>("tasks.agentCall", { id, seq }),
  // [WS-RPC] workspaces.tree
  getWorkspaceTree: (id: string, path: string) =>
    requestRpc<{ path: string; entries: WorkspaceEntry[] }>("workspaces.tree", { id, path }),
  // [WS-RPC] workspaces.file
  getWorkspaceFile: (id: string, path: string) =>
    requestRpc<{ content: string; binary: boolean; size: number; truncated: boolean }>(
      "workspaces.file", { id, path },
    ),
  // download / zip 走原生 HTTP 流（浏览器需要 URL 触发下载，不能走 WS）
  workspaceDownloadUrl: (id: string, path: string) =>
    `/api/tasks/${id}/ws/download?path=${encodeURIComponent(path)}`,
  workspaceZipUrl: (id: string) => `/api/tasks/${id}/ws/zip`,
  // [WS-RPC] workspaces.delete
  deleteWorkspace: (id: string) =>
    requestRpc<{ ok: boolean; removed: boolean }>("workspaces.delete", { id }),
  // [WS-RPC] workspaces.usage
  getWorkspaceUsage: () =>
    requestRpc<{ total: number; tasks: Array<{ taskId: string; size: number; mtime: number; exists: boolean }> }>(
      "workspaces.usage",
    ),
  // [WS-RPC] workflows.list — P3 第一批 PoC
  listWorkflows: () =>
    requestRpc<
      Array<{
        name: string;
        label?: string;
        description: string;
        source?: "db" | "file";
        derives_from?: string | null;
      }>
    >("workflows.list"),
  // [WS-RPC] workflows.get
  getWorkflow: (name: string) =>
    requestRpc<{
      name: string;
      label?: string;
      description?: string;
      source?: "db" | "file";
      derives_from?: string | null;
      [key: string]: unknown;
    }>("workflows.get", { name }),
  // [WS-RPC] workflows.graph
  getWorkflowGraph: (name: string) => requestRpc<any>("workflows.graph", { name }),
  createWorkflow: (body: {
    name: string;
    description?: string;
    firstPhase?: string;
    derives_from?: string;
    yaml_content?: string;
  }) =>
    request<{ ok: boolean; name: string; source?: string; dir?: string }>("/api/workflows", {
      method: "POST", body: JSON.stringify(body),
    }),
  // [WS-RPC] workflows.templates（RPC handler 返回 wrap {templates:[]}）
  listWorkflowTemplates: () =>
    requestRpc<{ templates: WorkflowTemplate[] }>("workflows.templates").then((r) => r.templates),
  createWorkflowFromTemplate: (body: { template: string; name: string }) =>
    request<{ ok: boolean; name: string }>("/api/workflows/from-template", {
      method: "POST", body: JSON.stringify(body),
    }),
  /** 从用户已有的工作流克隆为新工作流（区别于 createWorkflowFromTemplate 只克隆 examples 模板） */
  cloneWorkflow: (sourceName: string, targetName: string) =>
    request<{ ok: boolean; name: string }>(
      `/api/workflows/${sourceName}/clone`,
      { method: "POST", body: JSON.stringify({ name: targetName }) },
    ),
  // [WS-RPC] workflows.exportBundle
  exportWorkflowBundle: (name: string) =>
    requestRpc<{
      version: number;
      name: string;
      yaml: string;
      ts: string | null;
      exported_at: string;
    }>("workflows.exportBundle", { name }),
  // [WS-RPC] workflows.importBundle
  importWorkflowBundle: (body: { name: string; yaml: string; ts: string | null }) =>
    requestRpc<{ ok: boolean; name: string }>("workflows.importBundle", body),
  // [WS-RPC] workflows.scanHealth
  scanWorkflowHealth: () =>
    requestRpc<WorkflowHealthReport>("workflows.scanHealth"),
  fixOrphanWorkflow: (dir: string) =>
    request<{ ok: boolean; fixed: boolean; oldName: string; newName: string }>(
      `/api/workflows/health/fix-orphan`,
      { method: "POST", body: JSON.stringify({ dir }) },
    ),
  // [WS-RPC] workflows.author（AI 长任务，给 5min 超时）
  authorWorkflow: (body: { description: string; prior_yaml?: string; prior_ts?: string }) =>
    requestRpc<AuthoredWorkflow>("workflows.author", body, { timeoutMs: 300_000 }),
  // [WS-RPC] workflows.saveAuthored
  saveAuthoredWorkflow: (body: { name: string; yaml: string; ts: string }) =>
    requestRpc<{ ok: boolean; name: string }>("workflows.saveAuthored", body),
  // [WS-RPC] workflows.delete
  deleteWorkflow: (name: string) =>
    requestRpc<{ ok: boolean }>("workflows.delete", { name }),
  setWorkflowPhases: (
    name: string,
    phases: unknown[],
    syncTs = true,
    renames?: Record<string, string>,
  ) =>
    request<{
      ok: boolean;
      ts: { added: string[]; orphans: string[]; modified: boolean; legacy_signature?: string[] } | null;
      ts_error?: string | null;
      renamed?: string[];
    }>(
      `/api/workflows/${name}/phases`,
      {
        method: "PUT",
        body: JSON.stringify({ phases, sync_ts: syncTs, renames }),
      },
    ),
  syncWorkflowTs: (name: string) =>
    request<{ added: string[]; orphans: string[]; modified: boolean; legacy_signature?: string[] }>(
      `/api/workflows/${name}/sync-ts`, { method: "POST" },
    ),
  pruneOrphans: (name: string, names: string[]) =>
    request<{ removed: string[] }>(`/api/workflows/${name}/prune-orphans`, {
      method: "POST", body: JSON.stringify({ names }),
    }),

  // Config
  // [WS-RPC] config.get
  getConfig: () => requestRpc<{ yaml: string }>("config.get"),
  // [WS-RPC] config.save
  saveConfig: (yaml: string) =>
    requestRpc<{ ok: boolean }>("config.save", { yaml }),
  // [WS-RPC] workflows.getYaml
  getWorkflowYaml: (name: string) => requestRpc<{ yaml: string }>("workflows.getYaml", { name }),
  // [WS-RPC] workflows.getTs
  getWorkflowTs: (name: string) => requestRpc<{ content: string }>("workflows.getTs", { name }),
  setWorkflowPhaseFn: (name: string, phase: string, code: string) =>
    request<{ ok: true; mode: "replaced" | "appended" }>(
      `/api/workflows/${name}/phase-fn/${phase}`,
      { method: "PUT", body: JSON.stringify({ code }) },
    ),
  /**
   * 试跑某 workflow 的 prompt。命名复用 agent 删除后：agent 字段是一个内联配置对象
   * （provider/model/system_prompt/...），省略则后端走 DEFAULT_AGENT 兜底。
   */
  dryRunPrompt: (
    workflowName: string,
    body: { agent?: InlineAgentConfig; prompt: string; timeout?: number },
  ) =>
    request<{
      text: string;
      durationMs: number;
      usage?: { input_tokens?: number; output_tokens?: number; total_cost_usd?: number };
    }>(
      `/api/workflows/${workflowName}/dry-run`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  // [WS-RPC] workflows.saveYaml
  saveWorkflowYaml: (name: string, yaml: string) =>
    requestRpc<{ ok: boolean }>("workflows.saveYaml", { name, yaml }),
  reloadWorkflows: () =>
    request<{ ok: boolean; workflows: any[] }>("/api/reload", { method: "POST" }),

  // Providers
  // [WS-RPC] providers.list
  listProviders: () => requestRpc<ProviderItem[]>("providers.list"),
  // [WS-RPC] providers.save
  saveProviderConfig: (name: string, cfg: Record<string, unknown>) =>
    requestRpc<{ ok: boolean }>("providers.save", { name, ...cfg }),
  // [WS-RPC] providers.statusAll
  getProvidersStatus: () => requestRpc<ProviderStatus[]>("providers.statusAll"),
  // [WS-RPC] providers.status
  getProviderStatus: (name: string) => requestRpc<ProviderStatus>("providers.status", { name }),
  // [WS-RPC] providers.models
  getProviderModels: (name: string) =>
    requestRpc<ProviderModelsResult>("providers.models", { name }),

  // Agents — 命名复用 agent 机制已删除（Phase 3）。
  // agent 配置现在内联挂在 phase 上；试跑见下方 dryRunAgent（收内联配置对象）。

  // Chat
  chat: (body: { message: string; session_id?: string; agent?: string; workflow?: string; title?: string }) =>
    request<{ session_id: string; message: ChatMessage }>("/api/chat", {
      method: "POST", body: JSON.stringify(body),
    }),
  // [WS-RPC] sessions.list
  listSessions: () => requestRpc<ChatSessionManifest[]>("sessions.list"),
  // [WS-RPC] sessions.get
  getSession: (id: string) =>
    requestRpc<ChatSessionManifest & { messages: ChatMessage[] }>("sessions.get", { id }),
  // [WS-RPC] sessions.delete
  deleteSession: (id: string) =>
    requestRpc<{ ok: true }>("sessions.delete", { id }),

  // Defaults（用户偏好）
  // [WS-RPC] defaults.get
  getDefaults: () =>
    requestRpc<{
      timezone: string | null;
      resolved_timezone: string;
      system_timezone: string;
    }>("defaults.get"),
  // [WS-RPC] defaults.save
  saveDefaults: (body: { timezone?: string | null }) =>
    requestRpc<{ ok: true; timezone: string | null }>("defaults.save", body),

  // 网络访问设置
  getDaemonListen: () => request<DaemonListenInfo>("/api/daemon/listen"),
  saveDaemonListen: (body: { host?: string; port?: number }) =>
    request<{ ok: true; host?: string; port?: number; restart_required: boolean }>(
      "/api/daemon/listen",
      { method: "PUT", body: JSON.stringify(body) },
    ),
  // [WS-RPC] daemon.setHost — 写 config.yaml.daemon.host
  setDaemonHost: (host: string) =>
    requestRpc<{ ok: true; host: string; restart_required: true }>("daemon.setHost", { host }),
  // [WS-RPC] daemon.restart — 请求 supervisor 重启 daemon（exit code 75）
  restartDaemon: () =>
    requestRpc<{ ok: boolean; scheduled_in_ms: number }>("daemon.restart"),
  // [WS-RPC] daemon.revealToken — 已鉴权调用方查看明文 token
  revealApiToken: () =>
    requestRpc<{ token: string; is_set: boolean }>("daemon.revealToken"),
  rotateApiToken: () =>
    request<{ ok: true; token: string; state: DaemonListenInfo["token"] }>(
      "/api/daemon/token/rotate",
      { method: "POST" },
    ),
  deleteApiToken: () =>
    request<{ ok: true; state: DaemonListenInfo["token"] }>(
      "/api/daemon/token",
      { method: "DELETE" },
    ),

  // Schedules
  // [WS-RPC] schedules.list
  listSchedules: () => requestRpc<Schedule[]>("schedules.list"),
  // [WS-RPC] schedules.get
  getSchedule: (id: string) => requestRpc<Schedule>("schedules.get", { id }),
  // [WS-RPC] schedules.create
  createSchedule: (body: {
    name: string;
    type: "once" | "cron";
    run_at?: string | null;
    cron_expr?: string | null;
    timezone?: string;
    workflow: string;
    title: string;
    requirement?: string | null;
    enabled?: boolean;
  }) => requestRpc<Schedule>("schedules.create", body),
  // [WS-RPC] schedules.update
  updateSchedule: (id: string, body: Record<string, unknown>) =>
    requestRpc<Schedule>("schedules.update", { id, ...body }),
  // [WS-RPC] schedules.delete
  deleteSchedule: (id: string) =>
    requestRpc<{ ok: true }>("schedules.delete", { id }),
  // [WS-RPC] schedules.runNow
  runScheduleNow: (id: string) =>
    requestRpc<{ ok: true; taskId: string }>("schedules.runNow", { id }),

  // [WS-RPC] agents.dryRun（LLM 调用，5min 超时）
  // 命名复用 agent 删除后：传一个内联 agent 配置对象（provider/model/system_prompt/...），
  // 省略 agent 字段则后端走 DEFAULT_AGENT 兜底。additional_system 叠加到 system_prompt 之后。
  dryRunAgent: (
    agent: InlineAgentConfig | undefined,
    body: { prompt: string; additional_system?: string; model?: string; max_turns?: number },
  ) =>
    requestRpc<{
      ok: boolean;
      elapsed_ms: number;
      result: {
        text: string;
        usage?: { input_tokens?: number; output_tokens?: number; total_cost_usd?: number };
      };
    }>(
      "agents.dryRun",
      { agent: mergeInlineAgent(agent, body), prompt: body.prompt, additional_system: body.additional_system },
      { timeoutMs: 300_000 },
    ),

  // Projects
  // [WS-RPC] projects.list — P3 第一批 PoC（RPC 直接返回数组，不再 wrap projects 字段）
  listProjects: () =>
    requestRpc<Project[]>("projects.list"),
  // [WS-RPC] projects.get
  getProject: (id: string) =>
    requestRpc<{ project: Project }>("projects.get", { id }).then((r) => r.project),
  // [WS-RPC] projects.create
  createProject: (body: { name: string; description?: string }) =>
    requestRpc<{ project: Project }>("projects.create", body).then((r) => r.project),
  // [WS-RPC] projects.update
  updateProject: (id: string, body: { name?: string; description?: string | null }) =>
    requestRpc<{ project: Project }>("projects.update", { id, ...body }).then((r) => r.project),
  // [WS-RPC] projects.delete
  deleteProject: (id: string) =>
    requestRpc<{ ok: true }>("projects.delete", { id }),
  // [WS-RPC] projects.codebases
  listProjectCodebases: (projectId: string) =>
    requestRpc<{ codebases: Codebase[] }>("projects.codebases", { id: projectId }).then((r) => r.codebases),
  // [WS-RPC] projects.addCodebase
  createProjectCodebase: (
    projectId: string,
    body: { alias: string; path: string; default_branch?: string; github_owner?: string | null; github_repo?: string | null },
  ) =>
    requestRpc<{ codebase: Codebase }>("projects.addCodebase", { id: projectId, ...body }).then((r) => r.codebase),
  // [WS-RPC] codebases.delete —— 默认拒删 in-use codebase；force=true 才允许级联清空
  deleteCodebase: (codebaseId: string, force = false) =>
    requestRpc<{ ok: true }>("codebases.delete", { id: codebaseId, force }),
  // [WS-RPC] projects.requirements
  listProjectRequirements: (projectId: string) =>
    requestRpc<{ requirements: Requirement[] }>("projects.requirements", { id: projectId }).then((r) => r.requirements),

  // Codebases CRUD —— 走 WS RPC，handler 返回裸数据，无 envelope
  // [WS-RPC] codebases.list
  listCodebases: () =>
    requestRpc<Codebase[]>("codebases.list"),
  // [WS-RPC] codebases.get
  getCodebase: (id: string) =>
    requestRpc<Codebase>("codebases.get", { id }),
  // [WS-RPC] codebases.create
  createCodebase: (body: {
    alias: string;
    path: string;
    default_branch?: string;
    github_owner?: string | null;
    github_repo?: string | null;
    project_id?: string;
  }) =>
    requestRpc<Codebase>("codebases.create", body),
  // [WS-RPC] codebases.update
  updateCodebase: (id: string, body: Partial<{
    alias: string;
    path: string;
    default_branch: string;
    github_owner: string | null;
    github_repo: string | null;
  }>) =>
    requestRpc<Codebase>("codebases.update", { id, ...body }),
  // [WS-RPC] codebases.healthcheck
  healthcheckCodebase: (id: string) =>
    requestRpc<CodebaseHealthResult>("codebases.healthcheck", { id }),

  // Submodules（仅查询；自动发现写在 healthcheck 里）
  // [WS-RPC] codebases.listSubmodules
  listSubmodules: (parentId: string) =>
    requestRpc<{ submodules: Codebase[] }>("codebases.listSubmodules", { id: parentId }).then((r) => r.submodules),
  // [WS-RPC] codebases.rediscoverSubmodules
  rediscoverSubmodules: (parentId: string) =>
    requestRpc<RediscoverSubmodulesResult>("codebases.rediscoverSubmodules", { id: parentId }),

  // 文件系统浏览
  browseFs: (path?: string, showHidden = false) => {
    const params = new URLSearchParams();
    if (path) params.set("path", path);
    if (showHidden) params.set("show_hidden", "1");
    const qs = params.toString();
    return request<FsListResult>(`/api/fs/list${qs ? "?" + qs : ""}`);
  },

  // 首跑配置 setup
  // [WS-RPC] setup.status
  setupStatus: () => requestRpc<DoctorReportWithDismiss>("setup.status"),

  // [WS-RPC] setup.saveProviders
  setupProviders: (providers: Record<string, Record<string, unknown>>) =>
    requestRpc<{ report: DoctorReportWithDismiss }>("setup.saveProviders", { providers }),

  // setup.saveAgents 已移除（Phase 3：命名复用 agent 机制删除；首跑向导不再单独配 agent）。

  // [WS-RPC] setup.saveCodebases
  setupCodebase: (payload: { name: string; path: string; project_id?: string }) =>
    requestRpc<{ codebase: { id: string; alias: string; path: string; project_id: string } }>(
      "setup.saveCodebases",
      payload,
    ),

  // [WS-RPC] setup.dismiss
  setupDismiss: () =>
    requestRpc<{ ok: boolean }>("setup.dismiss"),

  // [WS-RPC] requirements.extract（LLM 长任务，5min 超时）
  extractRequirement: (input: { raw_text: string; project_id: string; codebase_id?: string | null }) =>
    requestRpc<{ title: string; spec_md: string }>("requirements.extract", input, { timeoutMs: 300_000 }),

  // Requirements
  // [WS-RPC] requirements.list
  listRequirements: (filters?: { codebase_id?: string; project_id?: string; status?: string }) =>
    requestRpc<{ requirements: Requirement[] }>("requirements.list", filters ?? {})
      .then((r) => r.requirements),

  // [WS-RPC] requirements.get （返回 comments，UI 沿用 feedbacks/questions 视图，由 adapter 拆分）
  getRequirement: async (id: string) => {
    const res = await requestRpc<{ requirement: Requirement; comments: Comment[] }>("requirements.get", { id });
    return {
      requirement: res.requirement,
      comments: res.comments,
      feedbacks: commentsToFeedbacks(res.comments),
    };
  },

  // [WS-RPC] requirements.create
  createRequirement: (body: {
    project_id?: string;
    codebase_id?: string | null;
    title: string;
    spec_md?: string;
    chat_session_id?: string | null;
  }) =>
    requestRpc<{ requirement: Requirement }>("requirements.create", body).then((r) => r.requirement),

  // [WS-RPC] requirements.update
  updateRequirement: (id: string, body: {
    title?: string;
    spec_md?: string;
    codebase_id?: string | null;
    chat_session_id?: string | null;
    clarifier_provider?: string | null;
    clarifier_model?: string | null;
  }) =>
    requestRpc<{ requirement: Requirement }>("requirements.update", { id, ...body }).then((r) => r.requirement),

  // [WS-RPC] requirements.delete
  deleteRequirement: (id: string) =>
    requestRpc<{ ok: true }>("requirements.delete", { id }),

  // [WS-RPC] requirements.transition
  transitionRequirement: (id: string, to: string) =>
    requestRpc<{ requirement: Requirement }>("requirements.transition", { id, to }).then((r) => r.requirement),

  // [WS-RPC] requirements.enqueue
  enqueueRequirement: (id: string) =>
    requestRpc<{ requirement: Requirement }>("requirements.enqueue", { id }).then((r) => r.requirement),

  // [WS-RPC] requirements.injectFeedback
  /** 注入反馈：comments.add(kind=feedback) 的语法糖；在 awaiting_review 自动触发 fix_revision */
  injectFeedback: (id: string, body: string, source: "manual" | "github_review" = "manual") =>
    requestRpc<{ comment: Comment }>("comments.add", {
      requirementId: id,
      kind: "feedback",
      from_role: source === "github_review" ? "github" : "user",
      body,
    }).then((r) => r.comment),

  // [WS-RPC] requirements.cancel
  cancelRequirement: (id: string) =>
    requestRpc<{ requirement: Requirement }>("requirements.cancel", { id }).then((r) => r.requirement),

  // [WS-RPC] requirements.subPrs
  listRequirementSubPrs: (id: string) =>
    requestRpc<{ sub_prs: RequirementSubPr[] }>("requirements.subPrs", { id }).then((r) => r.sub_prs),

  // [WS-RPC] requirements.specRevisions
  listSpecRevisions: (id: string) =>
    requestRpc<{ revisions: SpecRevision[] }>("requirements.specRevisions", { id }).then((r) => r.revisions),

  // [WS-RPC] requirements.clarifierRound
  getClarifierRound: (id: string) =>
    requestRpc<{ round: ClarifierRoundState | null }>("requirements.clarifierRound", { id })
      .then((r) => r.round),

  // Comments（统一评论线程：question / feedback / handoff）
  // [WS-RPC] comments.list
  listComments: (reqId: string, filter?: { kind?: "question" | "feedback" | "handoff"; status?: "open" | "resolved" }) =>
    requestRpc<{ comments: Comment[] }>("comments.list", { requirementId: reqId, ...(filter ?? {}) })
      .then((r) => r.comments),
  /** 兼容 web 旧用法：返回 Question[]（顶层 question + replies 嵌套），由 Comment[] 适配 */
  listQuestions: (reqId: string): Promise<Question[]> =>
    requestRpc<{ comments: Comment[] }>("comments.list", { requirementId: reqId, kind: "question" })
      .then((r) => commentsToQuestions(r.comments)),
  // [WS-RPC] comments.add（用于在某 question 下追加 reply）
  addQuestionReply: (reqId: string, qid: string, body: { author_role: "agent" | "user"; text: string }) =>
    requestRpc<{ comment: Comment }>("comments.add", {
      requirementId: reqId,
      kind: "question",
      parent_id: qid,
      from_role: body.author_role,
      body: body.text,
    }).then((r) => r.comment),
  // [WS-RPC] comments.resolve
  resolveQuestion: (_reqId: string, qid: string) =>
    requestRpc<{ ok: true }>("comments.resolve", { id: qid }),

  // /now state-derivation engine (PR 1 backend)
  // [WS-RPC] now.cards（RPC handler 直接返回数组，不再 wrap cards 字段）
  listNowCards: () => requestRpc<NowCard[]>("now.cards"),
  // [WS-RPC] now.dismissCard
  dismissNowCard: (cardId: string) =>
    requestRpc<{ ok: true }>("now.dismissCard", { id: cardId }),
};

export interface WorkflowTemplate {
  name: string;
  label?: string;
  description: string;
  phase_count: number;
  agent_count: number;
}

export interface OrphanWorkflow {
  dir: string;
  yamlName: string;
  issue: "name_mismatch";
  suggestion: string;
}

export interface WorkflowCollision {
  name: string;
  dirs: string[];
}

export interface WorkflowHealthReport {
  orphans: OrphanWorkflow[];
  collisions: WorkflowCollision[];
}

export interface AuthoredWorkflow {
  name: string;
  description: string;
  yaml: string;
  ts: string;
  warnings: string[];
}

export interface TaskPhaseEvent {
  id: number;
  task_id: string;
  phase: string;
  status: "running" | "done" | "awaiting" | "failed";
  started_at: number;
  ended_at: number | null;
}

export interface TaskOutcome {
  task_id: string;
  status: "done" | "failed" | "cancelled";
  pr_url: string | null;
  pr_number: number | null;
  diff_stat: { files: number; insertions: number; deletions: number } | null;
  total_duration_ms: number;
  top_phases: Array<{ phase: string; duration_ms: number }>;
  workspace_path: string | null;
  failure_reason: string | null;
}

export interface DoctorCheck {
  id: string;
  category: "config" | "provider" | "agent" | "project" | "codebase";
  status: "ok" | "warning" | "error" | "skipped";
  title: string;
  detail?: string;
  fix?: { cli?: string; url?: string; auto?: string };
}

export interface DoctorReportWithDismiss {
  level: 1 | 2 | 3;
  status: "ok" | "warning" | "error";
  checks: DoctorCheck[];
  durationMs: number;
  generatedAt: string;
  setupDismissed?: boolean;
}

export interface ProviderItem {
  name: string;
  default_model?: string;
  enabled?: boolean;
  agent_count?: number;
}

export interface ProviderStatus {
  name: string;
  cli_installed: boolean;
  cli_path?: string;
  cli_version?: string;
  error?: string;
  install_hint?: string;
}

export interface ProviderModelsResult {
  name: string;
  models: string[];
  source: "api" | "catalog";
  error?: string;
}

export interface AgentCallSummary {
  seq: number;
  ts: string;
  phase?: string;
  agent: string;
  provider?: string;
  model?: string;
  elapsed_ms?: number;
  usage?: { input_tokens?: number; output_tokens?: number; total_cost_usd?: number };
  error?: string;
  prompt_preview: string;
  result_preview: string;
}

export interface AgentCallRecord extends AgentCallSummary {
  prompt: string;
  system_prompt?: string;
  additional_system?: string;
  result_text?: string;
}

export interface WorkspaceEntry {
  name: string;
  type: "file" | "dir";
  size?: number;
  mtime?: number;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  ts: string;
  usage?: { input_tokens?: number; output_tokens?: number; total_cost_usd?: number };
}

export interface Schedule {
  id: string;
  name: string;
  type: "once" | "cron";
  run_at: string | null;
  cron_expr: string | null;
  timezone: string;
  workflow: string;
  title: string;
  requirement: string | null;
  enabled: 0 | 1;
  next_run_at: string | null;
  last_run_at: string | null;
  last_task_id: string | null;
  run_count: number;
  created_at: string;
  updated_at: string;
}

export interface ChatSessionManifest {
  version: 1;
  id: string;
  title?: string;
  agent: string;
  workflow?: string;
  provider_session_id?: string;
  created_at: string;
  updated_at: string;
  message_count: number;
}

export interface CodebaseHealthResult {
  healthy: boolean;
  issues: string[];
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  created_at: number;
  updated_at: number;
}

export interface Codebase {
  id: string;
  project_id: string;
  alias: string;
  path: string;
  default_branch: string;
  github_owner: string | null;
  github_repo: string | null;
  parent_codebase_id: string | null;
  submodule_path: string | null;
  created_at: number;
  updated_at: number;
}

export interface Comment {
  id: string;
  requirement_id: string;
  parent_id: string | null;
  kind: "question" | "feedback" | "handoff";
  from_role: "agent" | "user" | "github";
  body: string;
  suggestions: string[] | null;
  status: "open" | "resolved";
  github_review_id: string | null;
  created_at: number;
  resolved_at: number | null;
}

// ── Legacy 视图类型（UI 沿用，由 Comment 适配） ──
// Phase 2 数据层已合并到 requirement_comments；保留这些类型让 UI 不必大改。
// 等 UI 全面用 Comment 直接渲染时再删（spec follow-up）。

export interface QuestionReply {
  id: string;
  question_id: string;
  author_role: "agent" | "user";
  text: string;
  created_at: number;
}

export interface Question {
  id: string;
  requirement_id: string;
  agent_text: string;
  suggestions: string[];
  status: "open" | "resolved";
  created_at: number;
  resolved_at: number | null;
  replies?: QuestionReply[];
}

export interface Requirement {
  id: string;
  codebase_id: string | null;
  project_id: string;
  title: string;
  status: string;
  spec_md: string;
  chat_session_id: string | null;
  task_id: string | null;
  pr_url: string | null;
  pr_number: number | null;
  last_reviewed_event_id: string | null;
  /** PR-A 新加：当前等用户回答的 question id（clarifying 期 AI 决定下一题时 set） */
  active_question_id: string | null;
  /** clarifier 失败时 set 错误原因，成功时 clear；持久化到 DB，跨重启/navigation 可见 */
  clarifier_error: string | null;
  clarifier_provider: string | null;
  clarifier_model: string | null;
  created_at: number;
  updated_at: number;
}

export interface RequirementFeedback {
  id: number;
  requirement_id: string;
  source: "github_review" | "manual";
  body: string;
  github_review_id: string | null;
  created_at: number;
}

export interface RequirementSubPr {
  id: number;
  requirement_id: string;
  child_repo_id: string;
  pr_url: string;
  pr_number: number;
  created_at: number;
}

export interface SpecRevision {
  id: number;
  requirement_id: string;
  before_md: string;
  after_md: string;
  summary: string | null;
  source: "clarifier" | "user-edit" | "system";
  triggered_by_question_id: string | null;
  created_at: number;
}

export interface ClarifierRoundState {
  req_id: string;
  started_at: number;
  phase: "preparing" | "calling-llm" | "parsing" | "writing" | "done" | "aborted" | "errored";
  attempt: 0 | 1;
  prompt: string | null;
  last_parse_error: string | null;
}

export interface RediscoverSubmodulesResult {
  added: Array<{ id: string; alias: string; submodule_path: string | null }>;
  existing_count: number;
  warnings: string[];
}

export interface FsListResult {
  current_path: string;
  parent_path: string | null;
  entries: { name: string; is_dir: boolean }[];
  /** 后端截断到 2000 entries 时为 true（系统大目录保护）；老 daemon 不返回此字段 */
  truncated?: boolean;
}
