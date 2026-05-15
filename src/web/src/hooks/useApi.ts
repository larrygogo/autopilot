import type { NowCard } from "../lib/now-types";

const BASE = "";

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
  getStatus: () => request<any>("/api/status"),
  listTasks: (filters?: Record<string, string>) => {
    const params = new URLSearchParams(filters);
    const qs = params.toString();
    return request<any[]>(`/api/tasks${qs ? `?${qs}` : ""}`);
  },
  getTask: (id: string) => request<any>(`/api/tasks/${id}`),
  startTask: (body: { title?: string; requirement?: string; workflow?: string; reqId?: string }) =>
    request<any>("/api/tasks", { method: "POST", body: JSON.stringify(body) }),
  cancelTask: (id: string) =>
    request<any>(`/api/tasks/${id}/cancel`, { method: "POST" }),
  deleteTask: (id: string) =>
    request<{ ok: true; deleted: string[] }>(`/api/tasks/${id}`, { method: "DELETE" }),
  restartTask: (id: string) =>
    request<{ ok: true; phase: string; from: string }>(
      `/api/tasks/${id}/restart`,
      { method: "POST" },
    ),
  decideTask: (id: string, decision: "pass" | "reject" | "cancel", note?: string) =>
    request<{ from: string; to: string; decision: string; note: string }>(
      `/api/tasks/${id}/decide`,
      { method: "POST", body: JSON.stringify({ decision, note }) },
    ),
  answerTask: (id: string, text: string) =>
    request<{ ok: true }>(
      `/api/tasks/${id}/answer`,
      { method: "POST", body: JSON.stringify({ text }) },
    ),
  getTaskLogs: (id: string, limit = 100) =>
    request<any[]>(`/api/tasks/${id}/logs?limit=${limit}`),
  getPhaseLogsList: (id: string) =>
    request<Array<{ phase: string; size: number; mtime: number }>>(`/api/tasks/${id}/phase-logs`),
  getPhaseLog: (id: string, phase: string, tail?: number) =>
    request<{ phase: string; content: string }>(
      `/api/tasks/${id}/phase-logs/${phase}${tail ? `?tail=${tail}` : ""}`,
    ),
  getDaemonLog: (tail = 500) =>
    request<{ path: string | null; content: string }>(`/api/daemon/log?tail=${tail}`),
  listAgentCalls: (id: string) =>
    request<AgentCallSummary[]>(`/api/tasks/${id}/agent-calls`),
  getAgentCall: (id: string, seq: number) =>
    request<AgentCallRecord>(`/api/tasks/${id}/agent-calls/${seq}`),
  getWorkspaceTree: (id: string, path: string) =>
    request<{ path: string; entries: WorkspaceEntry[] }>(
      `/api/tasks/${id}/ws/tree?path=${encodeURIComponent(path)}`,
    ),
  getWorkspaceFile: (id: string, path: string) =>
    request<{ content: string; binary: boolean; size: number; truncated: boolean }>(
      `/api/tasks/${id}/ws/file?path=${encodeURIComponent(path)}`,
    ),
  workspaceDownloadUrl: (id: string, path: string) =>
    `/api/tasks/${id}/ws/download?path=${encodeURIComponent(path)}`,
  workspaceZipUrl: (id: string) => `/api/tasks/${id}/ws/zip`,
  deleteWorkspace: (id: string) =>
    request<{ ok: boolean; removed: boolean }>(`/api/tasks/${id}/ws`, { method: "DELETE" }),
  getWorkspaceUsage: () =>
    request<{ total: number; tasks: Array<{ taskId: string; size: number; mtime: number; exists: boolean }> }>(
      `/api/workspaces/usage`,
    ),
  listWorkflows: () =>
    request<
      Array<{
        name: string;
        label?: string;
        description: string;
        source?: "db" | "file";
        derives_from?: string | null;
      }>
    >("/api/workflows"),
  getWorkflow: (name: string) =>
    request<{
      name: string;
      label?: string;
      description?: string;
      source?: "db" | "file";
      derives_from?: string | null;
      [key: string]: unknown;
    }>(`/api/workflows/${name}`),
  getWorkflowGraph: (name: string) => request<any>(`/api/workflows/${name}/graph`),
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
  listWorkflowTemplates: () =>
    request<{ templates: WorkflowTemplate[] }>("/api/workflows/templates").then((r) => r.templates),
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
  authorWorkflow: (body: { description: string; prior_yaml?: string; prior_ts?: string }) =>
    request<AuthoredWorkflow>("/api/workflows/author", {
      method: "POST", body: JSON.stringify(body),
    }),
  saveAuthoredWorkflow: (body: { name: string; yaml: string; ts: string }) =>
    request<{ ok: boolean; name: string }>("/api/workflows/author/save", {
      method: "POST", body: JSON.stringify(body),
    }),
  deleteWorkflow: (name: string) =>
    request<{ ok: boolean }>(`/api/workflows/${name}`, { method: "DELETE" }),
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
  getConfig: () => request<{ yaml: string }>("/api/config"),
  saveConfig: (yaml: string) =>
    request<{ ok: boolean }>("/api/config", { method: "PUT", body: JSON.stringify({ yaml }) }),
  getWorkflowYaml: (name: string) => request<{ yaml: string }>(`/api/workflows/${name}/yaml`),
  getWorkflowTs: (name: string) => request<{ content: string }>(`/api/workflows/${name}/ts`),
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
  saveWorkflowYaml: (name: string, yaml: string) =>
    request<{ ok: boolean }>(`/api/workflows/${name}/yaml`, { method: "PUT", body: JSON.stringify({ yaml }) }),
  reloadWorkflows: () =>
    request<{ ok: boolean; workflows: any[] }>("/api/reload", { method: "POST" }),

  // Providers
  listProviders: () => request<ProviderItem[]>("/api/providers"),
  saveProviderConfig: (name: string, cfg: Record<string, unknown>) =>
    request<{ ok: boolean }>(`/api/providers/${name}`, { method: "PUT", body: JSON.stringify(cfg) }),
  getProvidersStatus: () => request<ProviderStatus[]>("/api/providers/status"),
  getProviderStatus: (name: string) => request<ProviderStatus>(`/api/providers/${name}/status`),
  getProviderModels: (name: string) =>
    request<ProviderModelsResult>(`/api/providers/${name}/models`),

  // Agents
  listAgents: () => request<AgentItem[]>("/api/agents"),
  getAgent: (name: string) => request<AgentItem>(`/api/agents/${name}`),
  createAgent: (body: AgentItem) =>
    request<{ ok: boolean; name: string }>("/api/agents", { method: "POST", body: JSON.stringify(body) }),
  updateAgent: (name: string, body: Record<string, unknown>) =>
    request<{ ok: boolean }>(`/api/agents/${name}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteAgent: (name: string) =>
    request<{ ok: boolean }>(`/api/agents/${name}`, { method: "DELETE" }),
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
  getDefaults: () =>
    request<{
      timezone: string | null;
      resolved_timezone: string;
      system_timezone: string;
    }>("/api/defaults"),
  saveDefaults: (body: { timezone?: string | null }) =>
    request<{ ok: true; timezone: string | null }>("/api/defaults", {
      method: "PUT",
      body: JSON.stringify(body),
    }),

  // Schedules
  listSchedules: () => request<Schedule[]>("/api/schedules"),
  getSchedule: (id: string) => request<Schedule>(`/api/schedules/${id}`),
  createSchedule: (body: {
    name: string;
    type: "once" | "cron";
    run_at?: string | null;
    cron_expr?: string | null;
    /** 省略则后端使用 defaults.timezone 或机器时区 */
    timezone?: string;
    workflow: string;
    title: string;
    requirement?: string | null;
    enabled?: boolean;
  }) => request<Schedule>("/api/schedules", { method: "POST", body: JSON.stringify(body) }),
  updateSchedule: (id: string, body: Record<string, unknown>) =>
    request<Schedule>(`/api/schedules/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteSchedule: (id: string) =>
    request<{ ok: true }>(`/api/schedules/${id}`, { method: "DELETE" }),
  runScheduleNow: (id: string) =>
    request<{ ok: true; taskId: string }>(`/api/schedules/${id}/run-now`, { method: "POST" }),

  dryRunAgent: (name: string, body: {
    prompt: string;
    system_prompt?: string;
    additional_system?: string;
    model?: string;
    max_turns?: number;
  }) =>
    request<{
      ok: boolean;
      elapsed_ms: number;
      result: {
        text: string;
        usage?: { input_tokens?: number; output_tokens?: number; total_cost_usd?: number };
      };
    }>(`/api/agents/${name}/dry-run`, { method: "POST", body: JSON.stringify(body) }),

  // Projects
  listProjects: () =>
    request<{ projects: Project[] }>("/api/projects").then((r) => r.projects),
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
  setupStatus: () => request<DoctorReportWithDismiss>("/api/setup/status"),

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

  setupDismiss: () =>
    request<{ ok: boolean }>("/api/setup/dismiss", { method: "POST" }),

  extractRequirement: (input: { raw_text: string; project_id: string; codebase_id?: string | null }) =>
    request<{ title: string; spec_md: string }>("/api/requirements/extract", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),

  // Requirements
  listRequirements: (filters?: { repo_id?: string; project_id?: string; status?: string }) => {
    const params = new URLSearchParams();
    if (filters?.repo_id) params.set("repo_id", filters.repo_id);
    if (filters?.project_id) params.set("project_id", filters.project_id);
    if (filters?.status) params.set("status", filters.status);
    const qs = params.toString();
    return request<{ requirements: Requirement[] }>(`/api/requirements${qs ? "?" + qs : ""}`)
      .then((r) => r.requirements);
  },

  getRequirement: (id: string) =>
    request<{ requirement: Requirement; feedbacks: RequirementFeedback[] }>(`/api/requirements/${id}`),

  createRequirement: (body: {
    project_id?: string;
    codebase_id?: string | null;
    repo_id?: string;
    title: string;
    spec_md?: string;
    chat_session_id?: string | null;
  }) =>
    request<{ requirement: Requirement }>("/api/requirements", {
      method: "POST",
      body: JSON.stringify(body),
    }).then((r) => r.requirement),

  updateRequirement: (id: string, body: {
    title?: string;
    spec_md?: string;
    codebase_id?: string | null;
    chat_session_id?: string | null;
    clarifier_provider?: string | null;
    clarifier_model?: string | null;
  }) =>
    request<{ requirement: Requirement }>(`/api/requirements/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }).then((r) => r.requirement),

  deleteRequirement: (id: string) =>
    request<{ ok: true }>(`/api/requirements/${id}`, { method: "DELETE" }),

  transitionRequirement: (id: string, to: string) =>
    request<{ requirement: Requirement }>(`/api/requirements/${id}/transition`, {
      method: "POST",
      body: JSON.stringify({ to }),
    }).then((r) => r.requirement),

  enqueueRequirement: (id: string) =>
    request<{ requirement: Requirement }>(`/api/requirements/${id}/enqueue`, {
      method: "POST",
    }).then((r) => r.requirement),

  injectFeedback: (id: string, body: string, source: "manual" | "github_review" = "manual") =>
    request<{ ok: true }>(`/api/requirements/${id}/inject_feedback`, {
      method: "POST",
      body: JSON.stringify({ body, source }),
    }),

  cancelRequirement: (id: string) =>
    request<{ requirement: Requirement }>(`/api/requirements/${id}/cancel`, {
      method: "POST",
    }).then((r) => r.requirement),

  listRequirementSubPrs: (id: string) =>
    request<{ sub_prs: RequirementSubPr[] }>(`/api/requirements/${id}/sub-prs`).then((r) => r.sub_prs),

  listSpecRevisions: (id: string) =>
    request<{ revisions: SpecRevision[] }>(`/api/requirements/${id}/spec-revisions`).then((r) => r.revisions),

  getClarifierRound: (id: string) =>
    request<{ round: ClarifierRoundState | null }>(`/api/requirements/${encodeURIComponent(id)}/clarifier-round`)
      .then((r) => r.round),

  // Questions（评论线程）
  listQuestions: (reqId: string) =>
    request<{ questions: Question[] }>(`/api/requirements/${encodeURIComponent(reqId)}/questions`)
      .then((r) => r.questions),
  addQuestionReply: (reqId: string, qid: string, body: { author_role: "agent" | "user"; text: string }) =>
    request<{ reply: QuestionReply }>(
      `/api/requirements/${encodeURIComponent(reqId)}/questions/${encodeURIComponent(qid)}/replies`,
      { method: "POST", body: JSON.stringify(body) },
    ).then((r) => r.reply),
  resolveQuestion: (reqId: string, qid: string) =>
    request<{ ok: true }>(
      `/api/requirements/${encodeURIComponent(reqId)}/questions/${encodeURIComponent(qid)}/resolve`,
      { method: "POST" },
    ),

  // /now state-derivation engine (PR 1 backend)
  listNowCards: () => request<{ cards: NowCard[] }>("/api/now/cards").then((r) => r.cards),
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

export interface AuthoredWorkflow {
  name: string;
  description: string;
  yaml: string;
  ts: string;
  warnings: string[];
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
