import type { NowCard } from "../lib/now-types";
import { rpcCall } from "../lib/ws-singleton";
import { RpcCallError, type CallOptions } from "../lib/ws-rpc-client";

const BASE = "";

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
  /^\/api\/workflows\/[\w.\-]+\/agents$/,
  /^\/api\/codebases\/[\w.\-]+\/submodules$/,
  /^\/api\/codebases\/[\w.\-]+\/rediscover-submodules$/,
  /^\/api\/requirements\/[\w.\-]+\/sub-prs$/,
  /^\/api\/requirements\/[\w.\-]+\/spec-revisions$/,
  /^\/api\/requirements\/[\w.\-]+\/clarifier-round$/,
  // 顶层 collection endpoint（list/create，不匹配 /:id 详情）
  /^\/api\/providers(\?.*)?$/,
  /^\/api\/agents(\?.*)?$/,
  /^\/api\/schedules(\?.*)?$/,
  /^\/api\/defaults(\?.*)?$/,
  /^\/api\/codebases(\?.*)?$/,
  /^\/api\/fs\//,
  /^\/api\/requirements(\?.*)?$/,
  /^\/api\/projects(\?.*)?$/,
  /^\/api\/now\/cards(\?.*)?$/,
];

async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...opts,
      headers: { "Content-Type": "application/json", ...opts?.headers },
    });
  } catch (e: any) {
    throw new Error(`网络请求失败：${e?.message ?? String(e)}（daemon 是否在运行？）`);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    let msg = (body as any).error ?? `HTTP ${res.status}`;
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
  // decideTask 留 HTTP（复杂 inline handler，下一轮单独抽 helper 再切）
  decideTask: (id: string, decision: "pass" | "reject" | "cancel", note?: string) =>
    request<{ from: string; to: string; decision: string; note: string }>(
      `/api/tasks/${id}/decide`,
      { method: "POST", body: JSON.stringify({ decision, note }) },
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
  getDaemonLog: (tail = 500) =>
    request<{ path: string | null; content: string }>(`/api/daemon/log?tail=${tail}`),
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
  setWorkflowAgents: (name: string, agents: unknown[]) =>
    request<{ ok: boolean }>(`/api/workflows/${name}/agents`, {
      method: "PUT", body: JSON.stringify({ agents }),
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
  dryRunPrompt: (
    workflowName: string,
    body: { agent: string; prompt: string; timeout?: number },
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

  // Agents
  // [WS-RPC] agents.list
  listAgents: () => requestRpc<AgentItem[]>("agents.list"),
  // [WS-RPC] agents.get
  getAgent: (name: string) => requestRpc<AgentItem>("agents.get", { name }),
  // [WS-RPC] agents.create
  createAgent: (body: AgentItem) =>
    requestRpc<{ ok: boolean; name: string }>("agents.create", body),
  // [WS-RPC] agents.update
  updateAgent: (name: string, body: Record<string, unknown>) =>
    requestRpc<{ ok: boolean }>("agents.update", { name, ...body }),
  // [WS-RPC] agents.delete
  deleteAgent: (name: string) =>
    requestRpc<{ ok: boolean }>("agents.delete", { name }),
  // Chat
  chat: (body: { message: string; session_id?: string; agent?: string; workflow?: string; title?: string }) =>
    request<{ session_id: string; message: ChatMessage }>("/api/chat", {
      method: "POST", body: JSON.stringify(body),
    }),
  listSessions: () => request<ChatSessionManifest[]>("/api/sessions"),
  getSession: (id: string) =>
    request<ChatSessionManifest & { messages: ChatMessage[] }>(`/api/sessions/${id}`),
  deleteSession: (id: string) =>
    request<{ ok: true }>(`/api/sessions/${id}`, { method: "DELETE" }),

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
  dryRunAgent: (name: string, body: {
    prompt: string;
    system_prompt?: string;
    additional_system?: string;
    model?: string;
    max_turns?: number;
  }) =>
    requestRpc<{
      ok: boolean;
      elapsed_ms: number;
      result: {
        text: string;
        usage?: { input_tokens?: number; output_tokens?: number; total_cost_usd?: number };
      };
    }>("agents.dryRun", { name, ...body }, { timeoutMs: 300_000 }),

  // Projects
  // [WS-RPC] projects.list — P3 第一批 PoC（RPC 直接返回数组，不再 wrap projects 字段）
  listProjects: () =>
    requestRpc<Project[]>("projects.list"),
  getProject: (id: string) =>
    request<{ project: Project }>(`/api/projects/${encodeURIComponent(id)}`).then((r) => r.project),
  createProject: (body: { name: string; description?: string }) =>
    request<{ project: Project }>("/api/projects", {
      method: "POST",
      body: JSON.stringify(body),
    }).then((r) => r.project),
  updateProject: (id: string, body: { name?: string; description?: string | null }) =>
    request<{ project: Project }>(`/api/projects/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }).then((r) => r.project),
  deleteProject: (id: string) =>
    request<{ ok: true }>(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" }),
  listProjectCodebases: (projectId: string) =>
    request<{ codebases: Codebase[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/codebases`,
    ).then((r) => r.codebases),
  createProjectCodebase: (
    projectId: string,
    body: { alias: string; path: string; default_branch?: string; github_owner?: string | null; github_repo?: string | null },
  ) =>
    request<{ codebase: Codebase }>(
      `/api/projects/${encodeURIComponent(projectId)}/codebases`,
      { method: "POST", body: JSON.stringify(body) },
    ).then((r) => r.codebase),
  deleteCodebase: (codebaseId: string) =>
    request<{ ok: true }>(`/api/codebases/${encodeURIComponent(codebaseId)}`, { method: "DELETE" }),
  listProjectRequirements: (projectId: string) =>
    request<{ requirements: Requirement[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/requirements`,
    ).then((r) => r.requirements),

  // Codebases —— 后端响应包了 envelope（{ codebases } / { codebase }），统一在此解包返回裸数据
  listCodebases: () =>
    request<{ codebases: Codebase[] }>("/api/codebases").then((r) => r.codebases),
  getCodebase: (id: string) =>
    request<{ codebase: Codebase }>(`/api/codebases/${id}`).then((r) => r.codebase),
  createCodebase: (body: {
    alias: string;
    path: string;
    default_branch?: string;
    github_owner?: string | null;
    github_repo?: string | null;
    project_id?: string;
  }) =>
    request<{ codebase: Codebase }>("/api/codebases", {
      method: "POST",
      body: JSON.stringify(body),
    }).then((r) => r.codebase),
  updateCodebase: (id: string, body: Partial<{
    alias: string;
    path: string;
    default_branch: string;
    github_owner: string | null;
    github_repo: string | null;
  }>) =>
    request<{ codebase: Codebase }>(`/api/codebases/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }).then((r) => r.codebase),
  healthcheckCodebase: (id: string) =>
    request<CodebaseHealthResult>(`/api/codebases/${id}/healthcheck`, { method: "POST" }),

  // Submodules（仅查询；自动发现写在 healthcheck 里）
  listSubmodules: (parentId: string) =>
    request<{ submodules: Codebase[] }>(`/api/codebases/${parentId}/submodules`).then((r) => r.submodules),
  rediscoverSubmodules: (parentId: string) =>
    request<RediscoverSubmodulesResult>(
      `/api/codebases/${parentId}/rediscover-submodules`,
      { method: "POST" },
    ),

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

  setupProviders: (providers: Record<string, Record<string, unknown>>) =>
    request<{ report: DoctorReportWithDismiss }>("/api/setup/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providers }),
    }),

  setupAgents: (agents: Record<string, Record<string, unknown>>) =>
    request<{ report: DoctorReportWithDismiss }>("/api/setup/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agents }),
    }),

  setupCodebase: (payload: { name: string; path: string; project_id?: string }) =>
    request<{ codebase: { id: string; alias: string; path: string; project_id: string } }>(
      "/api/setup/codebases",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    ),

  // [WS-RPC] setup.dismiss
  setupDismiss: () =>
    requestRpc<{ ok: boolean }>("setup.dismiss"),

  // [WS-RPC] requirements.extract（LLM 长任务，5min 超时）
  extractRequirement: (input: { raw_text: string; project_id: string; codebase_id?: string | null }) =>
    requestRpc<{ title: string; spec_md: string }>("requirements.extract", input, { timeoutMs: 300_000 }),

  // Requirements
  // [WS-RPC] requirements.list
  listRequirements: (filters?: { repo_id?: string; project_id?: string; status?: string }) =>
    requestRpc<{ requirements: Requirement[] }>("requirements.list", filters ?? {})
      .then((r) => r.requirements),

  // [WS-RPC] requirements.get
  getRequirement: (id: string) =>
    requestRpc<{ requirement: Requirement; feedbacks: RequirementFeedback[] }>("requirements.get", { id }),

  // [WS-RPC] requirements.create
  createRequirement: (body: {
    project_id?: string;
    codebase_id?: string | null;
    repo_id?: string;
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
  injectFeedback: (id: string, body: string, source: "manual" | "github_review" = "manual") =>
    requestRpc<{ ok: true }>("requirements.injectFeedback", { id, body, source }),

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

  // Questions（评论线程）
  // [WS-RPC] requirements.questions
  listQuestions: (reqId: string) =>
    requestRpc<{ questions: Question[] }>("requirements.questions", { id: reqId }).then((r) => r.questions),
  // [WS-RPC] requirements.addReply
  addQuestionReply: (reqId: string, qid: string, body: { author_role: "agent" | "user"; text: string }) =>
    requestRpc<{ reply: QuestionReply }>("requirements.addReply", { id: reqId, qid, ...body }).then((r) => r.reply),
  // [WS-RPC] requirements.resolveQuestion
  resolveQuestion: (reqId: string, qid: string) =>
    requestRpc<{ ok: true }>("requirements.resolveQuestion", { id: reqId, qid }),

  // /now state-derivation engine (PR 1 backend)
  // [WS-RPC] now.cards（RPC handler 直接返回数组，不再 wrap cards 字段）
  listNowCards: () => requestRpc<NowCard[]>("now.cards"),
  dismissNowCard: (cardId: string) =>
    request<{ ok: true }>(
      `/api/now/cards/${encodeURIComponent(cardId)}/dismiss`,
      { method: "POST" },
    ),
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

export interface AgentItem {
  name: string;
  provider?: string;
  model?: string;
  max_turns?: number;
  permission_mode?: string;
  system_prompt?: string;
  extends?: string | null;
  used_by?: string[];
  [key: string]: unknown;
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

export interface QuestionReply {
  id: string;
  question_id: string;
  author_role: "agent" | "user";
  text: string;
  created_at: number;
}

export interface Requirement {
  id: string;
  repo_id: string;
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
}
