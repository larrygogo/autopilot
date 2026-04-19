const BASE = "";

/** 标记新添加的 API 路径（daemon 须是最新代码才有）。收到 404 时提示重启 daemon。 */
const NEW_API_PATTERNS: RegExp[] = [
  /^\/api\/workflows\/[\w.\-]+\/phases$/,
  /^\/api\/workflows\/[\w.\-]+\/sync-ts$/,
  /^\/api\/workflows\/[\w.\-]+\/agents$/,
  /^\/api\/providers/,
  /^\/api\/agents/,
  /^\/api\/schedules/,
  /^\/api\/defaults/,
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
  listWorkflows: () => request<any[]>("/api/workflows"),
  getWorkflow: (name: string) => request<any>(`/api/workflows/${name}`),
  getWorkflowGraph: (name: string) => request<any>(`/api/workflows/${name}/graph`),
  createWorkflow: (body: { name: string; description?: string; firstPhase?: string }) =>
    request<{ ok: boolean; name: string; dir: string }>("/api/workflows", {
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
};

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
