import type { Task, TaskLog } from "../core/db";
import type { DaemonStatus, GraphData } from "../daemon/protocol";
import type { SessionManifest, ChatMessage } from "../core/sessions";

// ──────────────────────────────────────────────
// HTTP REST 客户端
// ──────────────────────────────────────────────

export class HttpClient {
  constructor(private baseUrl: string) {}

  private async request<T>(path: string, opts?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...opts,
      headers: {
        "Content-Type": "application/json",
        ...opts?.headers,
      },
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }

    return res.json() as Promise<T>;
  }

  // ── Daemon ──

  async getStatus(): Promise<DaemonStatus> {
    return this.request("/api/status");
  }

  // ── Tasks ──

  async listTasks(filters?: { status?: string; workflow?: string; limit?: number }): Promise<Task[]> {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status);
    if (filters?.workflow) params.set("workflow", filters.workflow);
    if (filters?.limit) params.set("limit", String(filters.limit));
    const qs = params.toString();
    return this.request(`/api/tasks${qs ? `?${qs}` : ""}`);
  }

  async getTask(id: string): Promise<Task> {
    return this.request(`/api/tasks/${id}`);
  }

  async startTask(opts: {
    title?: string;
    requirement?: string;
    workflow?: string;
    /** 旧接口兼容：可选传入 reqId；不传则后端生成 task ID */
    reqId?: string;
  }): Promise<Task> {
    return this.request("/api/tasks", {
      method: "POST",
      body: JSON.stringify(opts),
    });
  }

  async cancelTask(id: string): Promise<{ from: string; to: string }> {
    return this.request(`/api/tasks/${id}/cancel`, { method: "POST" });
  }

  async triggerTransition(id: string, trigger: string, note?: string): Promise<{ from: string; to: string }> {
    return this.request(`/api/tasks/${id}/transition`, {
      method: "POST",
      body: JSON.stringify({ trigger, note }),
    });
  }

  async getTaskLogs(id: string, limit?: number): Promise<TaskLog[]> {
    const qs = limit ? `?limit=${limit}` : "";
    return this.request(`/api/tasks/${id}/logs${qs}`);
  }

  async getSubTasks(id: string): Promise<Task[]> {
    return this.request(`/api/tasks/${id}/subtasks`);
  }

  // ── Workflows ──

  async listWorkflows(): Promise<{ name: string; description: string }[]> {
    return this.request("/api/workflows");
  }

  async getWorkflow(name: string): Promise<Record<string, unknown>> {
    return this.request(`/api/workflows/${name}`);
  }

  async getWorkflowGraph(name: string): Promise<GraphData> {
    return this.request(`/api/workflows/${name}/graph`);
  }

  // ── Chat ──

  async chat(opts: {
    message: string;
    session_id?: string;
    agent?: string;
    workflow?: string;
    title?: string;
  }): Promise<{ session_id: string; message: ChatMessage }> {
    return this.request("/api/chat", {
      method: "POST",
      body: JSON.stringify(opts),
    });
  }

  async listSessions(): Promise<SessionManifest[]> {
    return this.request("/api/sessions");
  }

  async getSession(id: string): Promise<SessionManifest & { messages: ChatMessage[] }> {
    return this.request(`/api/sessions/${id}`);
  }

  async deleteSession(id: string): Promise<{ ok: true }> {
    return this.request(`/api/sessions/${id}`, { method: "DELETE" });
  }

  async getSessionMessages(id: string, limit?: number): Promise<ChatMessage[]> {
    const qs = limit ? `?limit=${limit}` : "";
    return this.request(`/api/sessions/${id}/messages${qs}`);
  }
}
