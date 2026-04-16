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

  // Config
  getConfig: () => request<{ yaml: string }>("/api/config"),
  saveConfig: (yaml: string) =>
    request<{ ok: boolean }>("/api/config", { method: "PUT", body: JSON.stringify({ yaml }) }),
  getWorkflowYaml: (name: string) => request<{ yaml: string }>(`/api/workflows/${name}/yaml`),
  saveWorkflowYaml: (name: string, yaml: string) =>
    request<{ ok: boolean }>(`/api/workflows/${name}/yaml`, { method: "PUT", body: JSON.stringify({ yaml }) }),
  reloadWorkflows: () =>
    request<{ ok: boolean; workflows: any[] }>("/api/reload", { method: "POST" }),
};
