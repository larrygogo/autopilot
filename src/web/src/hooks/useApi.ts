const BASE = "";

async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...opts?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as any).error ?? `HTTP ${res.status}`);
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

  // Config
  getConfig: () => request<{ yaml: string }>("/api/config"),
  saveConfig: (yaml: string) =>
    request<{ ok: boolean }>("/api/config", { method: "PUT", body: JSON.stringify({ yaml }) }),
  getWorkflowYaml: (name: string) => request<{ yaml: string }>(`/api/workflows/${name}/yaml`),
  saveWorkflowYaml: (name: string, yaml: string) =>
    request<{ ok: boolean }>(`/api/workflows/${name}/yaml`, { method: "PUT", body: JSON.stringify({ yaml }) }),
  reloadWorkflows: () =>
    request<{ ok: boolean; workflows: any[] }>("/api/reload", { method: "POST" }),

  // Providers
  listProviders: () => request<ProviderItem[]>("/api/providers"),
  saveProviderConfig: (name: string, cfg: Record<string, unknown>) =>
    request<{ ok: boolean }>(`/api/providers/${name}`, { method: "PUT", body: JSON.stringify(cfg) }),

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
  base_url?: string;
  enabled?: boolean;
  agent_count?: number;
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
