const BASE = "";

/** 标记新添加的 API 路径（daemon 须是最新代码才有）。收到 404 时提示重启 daemon。 */
const NEW_API_PATTERNS: RegExp[] = [
  /^\/api\/workflows\/[\w.\-]+\/phases$/,
  /^\/api\/workflows\/[\w.\-]+\/sync-ts$/,
  /^\/api\/workflows\/[\w.\-]+\/agents$/,
  /^\/api\/providers/,
  /^\/api\/agents/,
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
  startTask: (body: { reqId: string; title?: string; workflow?: string }) =>
    request<any>("/api/tasks", { method: "POST", body: JSON.stringify(body) }),
  cancelTask: (id: string) =>
    request<any>(`/api/tasks/${id}/cancel`, { method: "POST" }),
  getTaskLogs: (id: string, limit = 100) =>
    request<any[]>(`/api/tasks/${id}/logs?limit=${limit}`),
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

  // Agents
  listAgents: () => request<AgentItem[]>("/api/agents"),
  getAgent: (name: string) => request<AgentItem>(`/api/agents/${name}`),
  createAgent: (body: AgentItem) =>
    request<{ ok: boolean; name: string }>("/api/agents", { method: "POST", body: JSON.stringify(body) }),
  updateAgent: (name: string, body: Record<string, unknown>) =>
    request<{ ok: boolean }>(`/api/agents/${name}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteAgent: (name: string) =>
    request<{ ok: boolean }>(`/api/agents/${name}`, { method: "DELETE" }),
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
