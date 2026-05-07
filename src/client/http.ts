import type { Task, TaskLog } from "../core/db";
import type { DaemonStatus, GraphData } from "../daemon/protocol";
import type { SessionManifest, ChatMessage } from "../core/sessions";
import type { Schedule, ScheduleType } from "../core/schedules";

// ──────────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────────

export interface Repo {
  id: string;
  alias: string;
  path: string;
  default_branch: string;
  github_owner: string | null;
  github_repo: string | null;
  created_at: number;
  updated_at: number;
}

export interface RepoHealthResult {
  healthy: boolean;
  issues: string[];
}

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
    /** 额外工作流参数（如 repo_id），透传给 setup_func */
    [key: string]: unknown;
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

  async listWorkflows(): Promise<{ name: string; description: string; source?: "db" | "file"; derives_from?: string | null }[]> {
    return this.request("/api/workflows");
  }

  async getWorkflow(name: string): Promise<Record<string, unknown>> {
    return this.request(`/api/workflows/${encodeURIComponent(name)}`);
  }

  async getWorkflowGraph(name: string): Promise<GraphData> {
    return this.request(`/api/workflows/${encodeURIComponent(name)}/graph`);
  }

  async getWorkflowYaml(name: string): Promise<{ yaml: string }> {
    return this.request(`/api/workflows/${encodeURIComponent(name)}/yaml`);
  }

  async saveWorkflowYaml(name: string, yaml: string): Promise<{ ok: boolean }> {
    return this.request(`/api/workflows/${encodeURIComponent(name)}/yaml`, {
      method: "PUT",
      body: JSON.stringify({ yaml }),
    });
  }

  async createWorkflow(body: {
    name: string;
    description?: string;
    firstPhase?: string;
    derives_from?: string;
    yaml_content?: string;
  }): Promise<{ ok: boolean; name: string; source?: string; dir?: string }> {
    return this.request("/api/workflows", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async deleteWorkflow(name: string): Promise<{ ok: boolean }> {
    return this.request(`/api/workflows/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
  }

  /**
   * 导出工作流的 yaml 纯文本（GET /api/workflows/:name/export 返回 text/yaml）。
   * 不走 this.request（它默认 JSON.parse 响应体），需手写 fetch + text()。
   */
  async exportWorkflow(name: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/workflows/${encodeURIComponent(name)}/export`);
    if (!res.ok) {
      // 错误响应可能是 JSON（带 error 字段），尝试解析；失败则用 statusText
      let msg: string;
      try {
        const body = (await res.json()) as { error?: string };
        msg = body.error ?? `HTTP ${res.status}`;
      } catch {
        msg = `HTTP ${res.status} ${res.statusText}`;
      }
      throw new Error(msg);
    }
    return res.text();
  }

  // ── Schedules ──

  async listSchedules(): Promise<Schedule[]> {
    return this.request("/api/schedules");
  }

  async getSchedule(id: string): Promise<Schedule> {
    return this.request(`/api/schedules/${id}`);
  }

  async createSchedule(body: {
    name: string;
    type: ScheduleType;
    run_at?: string | null;
    cron_expr?: string | null;
    timezone: string;
    workflow: string;
    title: string;
    requirement?: string | null;
    enabled?: boolean;
  }): Promise<Schedule> {
    return this.request("/api/schedules", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async updateSchedule(id: string, body: Partial<{
    name: string;
    enabled: boolean;
    run_at: string | null;
    cron_expr: string | null;
    timezone: string;
    workflow: string;
    title: string;
    requirement: string | null;
  }>): Promise<Schedule> {
    return this.request(`/api/schedules/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  async deleteSchedule(id: string): Promise<{ ok: true }> {
    return this.request(`/api/schedules/${id}`, { method: "DELETE" });
  }

  async runScheduleNow(id: string): Promise<{ ok: true; taskId: string }> {
    return this.request(`/api/schedules/${id}/run-now`, { method: "POST" });
  }

  // ── Repos ──

  async listRepos(): Promise<Repo[]> {
    return this.request("/api/repos");
  }

  async getRepo(id: string): Promise<Repo> {
    return this.request(`/api/repos/${id}`);
  }

  async createRepo(body: {
    alias: string;
    path: string;
    default_branch?: string;
    github_owner?: string | null;
    github_repo?: string | null;
  }): Promise<Repo> {
    return this.request("/api/repos", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async updateRepo(id: string, body: Partial<{
    alias: string;
    path: string;
    default_branch: string;
    github_owner: string | null;
    github_repo: string | null;
  }>): Promise<Repo> {
    return this.request(`/api/repos/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }

  async deleteRepo(id: string): Promise<{ ok: true }> {
    return this.request(`/api/repos/${id}`, { method: "DELETE" });
  }

  async healthcheckRepo(id: string): Promise<RepoHealthResult> {
    return this.request(`/api/repos/${id}/healthcheck`, { method: "POST" });
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
