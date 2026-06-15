/**
 * CLI / 第三方 Node 客户端 — 名字保留 HttpClient 是历史包袱，
 * 内部已切到 WS RPC（参考 OpenClaw Gateway 协议）。
 *
 * 所有 method 签名跟之前 HTTP 版本一致；调用方零改动。
 * 不再走 fetch，全部走 WS RPC method。
 */

import type { Task, TaskLog } from "../core/db";
import type { DaemonStatus, GraphData } from "../daemon/protocol";
import type { SessionManifest, ChatMessage } from "../core/sessions";
import type { Requirement } from "../core/requirements";
import type { NowCard } from "../core/now-types";
import { WsRpcCaller, toWsUrl, WsRpcError } from "./ws-rpc";
export type { NowCard };

// ──────────────────────────────────────────────
// 类型定义（保留 HttpClient 历史 shape，不破坏 CLI / 测试调用方）
// ──────────────────────────────────────────────

export interface WorkspaceHealthResult {
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

export interface Workspace {
  id: string;
  project_id: string;
  alias: string;
  /** 历史字段，新 workspace 可能为 null */
  path: string | null;
  /** 远程仓库 URL（主字段） */
  remote_url: string | null;
  default_branch: string;
  github_owner: string | null;
  github_repo: string | null;
  parent_workspace_id: string | null;
  submodule_path: string | null;
  created_at: number;
  updated_at: number;
}

// ──────────────────────────────────────────────
// HttpClient — 名字保留兼容，内部走 WS RPC
// ──────────────────────────────────────────────

export class HttpClient {
  private rpc: WsRpcCaller;

  constructor(baseUrl: string) {
    this.rpc = new WsRpcCaller(toWsUrl(baseUrl));
  }

  /** 主动关闭底层 WS 连接（CLI 通常不需要调，进程退出会自动清理） */
  close(): void {
    this.rpc.close();
  }

  /** 内部 call wrapper：把 WsRpcError 转成普通 Error（保持跟原 fetch 失败一致的错误形状） */
  private async call<T>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<T> {
    try {
      return await this.rpc.call<T>(method, params, opts);
    } catch (e: unknown) {
      if (e instanceof WsRpcError) {
        // 跟原 HTTP 客户端一样直接抛 Error，body.error 等价于 e.message
        throw new Error(`${e.code}: ${e.message}`);
      }
      throw e;
    }
  }

  // ── Daemon ──

  async getStatus(): Promise<DaemonStatus> {
    return this.call("daemon.status");
  }

  // ── Tasks ──

  async listTasks(filters?: { status?: string; workflow?: string; limit?: number }): Promise<Task[]> {
    return this.call("tasks.list", filters ?? {});
  }

  async getTask(id: string): Promise<Task> {
    return this.call("tasks.get", { id });
  }

  async startTask(opts: {
    title?: string;
    requirement?: string;
    workflow?: string;
    reqId?: string;
    [key: string]: unknown;
  }): Promise<Task> {
    return this.call("tasks.start", opts, { timeoutMs: 300_000 });
  }

  /**
   * 一句话发包：跳过项目/需求/工作流选择，直接跑 ad-hoc 工作流。
   * 接 workspace_id 或 workspace_alias 任一（daemon 端解析）；workflow 默认 "ad-hoc"。
   */
  async startAdHocTask(opts: {
    prompt: string;
    workspace_id?: string;
    workspace_alias?: string;
    workflow?: string;
  }): Promise<Task> {
    return this.call("tasks.startAdHoc", opts, { timeoutMs: 300_000 });
  }

  async cancelTask(id: string): Promise<{ from: string; to: string }> {
    return this.call("tasks.cancel", { id });
  }

  /**
   * Phase 5: 运行中 task 追加 prompt。
   * mode: queued (running 排队) / answered (awaiting pending question)。
   * 终态 task 抛 TASK_TERMINAL。
   */
  async sendTaskPrompt(id: string, prompt: string): Promise<{ mode: "queued" | "answered"; accepted: boolean }> {
    return this.call("tasks.sendPrompt", { id, prompt });
  }

  async triggerTransition(_id: string, _trigger: string, _note?: string): Promise<{ from: string; to: string }> {
    // tasks.transition 还没注册 RPC（CLI 用，等用到时再加）；暂留占位以保签名
    throw new Error("triggerTransition 暂未迁到 WS RPC，请用 tasks.cancel / tasks.decide");
  }

  async getTaskLogs(id: string, limit?: number): Promise<TaskLog[]> {
    return this.call("tasks.logs", { id, limit });
  }

  // ── Workflows ──

  async listWorkflows(): Promise<{ name: string; description: string; source?: "db" | "file"; derives_from?: string | null }[]> {
    return this.call("workflows.list");
  }

  async getWorkflow(name: string): Promise<Record<string, unknown>> {
    return this.call("workflows.get", { name });
  }

  async getWorkflowGraph(name: string): Promise<GraphData> {
    return this.call("workflows.graph", { name });
  }

  async getWorkflowYaml(name: string): Promise<{ yaml: string }> {
    return this.call("workflows.getYaml", { name });
  }

  async saveWorkflowYaml(name: string, yaml: string): Promise<{ ok: boolean }> {
    return this.call("workflows.saveYaml", { name, yaml });
  }

  async createWorkflow(_body: {
    name: string;
    description?: string;
    firstPhase?: string;
    derives_from?: string;
    yaml_content?: string;
  }): Promise<{ ok: boolean; name: string; source?: string; dir?: string }> {
    // workflows.create 还没注册 RPC（复杂 mutation 留到后续）
    throw new Error("createWorkflow 暂未迁到 WS RPC，请用 workflows.saveAuthored / importBundle 路径");
  }

  async deleteWorkflow(name: string): Promise<{ ok: boolean }> {
    return this.call("workflows.delete", { name });
  }

  /**
   * 导出工作流——拿 yaml 字段。原 HTTP 版本返回 text/yaml 纯文本，
   * WS RPC 走 workflows.exportBundle 返回结构化 JSON，这里只取 yaml 字段保签名。
   */
  async exportWorkflow(name: string): Promise<string> {
    const bundle = await this.call<{ yaml: string }>("workflows.exportBundle", { name });
    return bundle.yaml;
  }

  // ── Projects ── (CLI 历史 wrap 风格 { projects } 保留)

  async listProjects(): Promise<{ projects: Project[] }> {
    // RPC handler 返回数组，wrap 一下兼容 CLI 历史签名
    const projects = await this.call<Project[]>("projects.list");
    return { projects };
  }

  async getProject(id: string): Promise<{ project: Project }> {
    return this.call("projects.get", { id });
  }

  async createProject(body: { name: string; description?: string }): Promise<{ project: Project }> {
    return this.call("projects.create", body);
  }

  async createProjectWithWorkspace(body: {
    name: string;
    path: string;
    alias?: string;
    description?: string;
  }): Promise<{ project: Project; workspace: Workspace }> {
    return this.call("projects.createWithWorkspace", body);
  }

  async updateProject(id: string, body: { name?: string; description?: string | null }): Promise<{ project: Project }> {
    return this.call("projects.update", { id, ...body });
  }

  async deleteProject(id: string): Promise<{ ok: true }> {
    return this.call("projects.delete", { id });
  }

  async listProjectWorkspaces(projectId: string): Promise<{ workspaces: Workspace[] }> {
    return this.call("projects.workspaces", { id: projectId });
  }

  async createProjectWorkspace(projectId: string, body: {
    alias: string;
    path: string;
    default_branch?: string;
    github_owner?: string | null;
    github_repo?: string | null;
  }): Promise<{ workspace: Workspace }> {
    return this.call("projects.addWorkspace", { id: projectId, ...body });
  }

  async listProjectRequirements(projectId: string): Promise<{ requirements: Requirement[] }> {
    return this.call("projects.requirements", { id: projectId });
  }

  // ── Workspaces ── （走 WS RPC workspaces.*，响应是裸数据无 envelope）

  async listWorkspaces(): Promise<{ workspaces: Workspace[] }> {
    const list = await this.call<Workspace[]>("workspaces.list", {});
    // 保持薄客户端旧签名（CLI 解构 { workspaces }），envelope 在此还原
    return { workspaces: list };
  }

  async getWorkspace(id: string): Promise<{ workspace: Workspace }> {
    const ws = await this.call<Workspace>("workspaces.get", { id });
    return { workspace: ws };
  }

  async createWorkspace(body: {
    alias: string;
    /** 历史兼容；新建流程不再要求 */
    path?: string | null;
    /** 远程仓库 URL（新建流程主入口） */
    remote_url?: string | null;
    default_branch?: string;
    github_owner?: string | null;
    github_repo?: string | null;
    project_id?: string;
  }): Promise<{ workspace: Workspace }> {
    const ws = await this.call<Workspace>("workspaces.create", body);
    return { workspace: ws };
  }

  async updateWorkspace(id: string, body: Partial<{
    alias: string;
    path: string | null;
    remote_url: string | null;
    default_branch: string;
    github_owner: string | null;
    github_repo: string | null;
  }>): Promise<{ workspace: Workspace }> {
    const ws = await this.call<Workspace>("workspaces.update", { id, ...body });
    return { workspace: ws };
  }

  async deleteWorkspace(id: string): Promise<{ ok: true }> {
    return this.call<{ ok: true }>("workspaces.delete", { id });
  }

  async healthcheckWorkspace(id: string): Promise<WorkspaceHealthResult> {
    return this.call<WorkspaceHealthResult>("workspaces.healthcheck", { id });
  }


  // ── Chat（流式聊天暂未迁，保留 placeholder） ──

  async chat(_opts: {
    message: string;
    session_id?: string;
    agent?: string;
    workflow?: string;
    title?: string;
  }): Promise<{ session_id: string; message: ChatMessage }> {
    throw new Error("chat 流式接口暂未迁到 WS RPC（POST /api/chat 保留 HTTP）");
  }

  async listSessions(): Promise<SessionManifest[]> {
    return this.call("sessions.list");
  }

  async getSession(id: string): Promise<SessionManifest & { messages: ChatMessage[] }> {
    return this.call("sessions.get", { id });
  }

  async deleteSession(id: string): Promise<{ ok: true }> {
    return this.call("sessions.delete", { id });
  }

  async getSessionMessages(_id: string, _limit?: number): Promise<ChatMessage[]> {
    throw new Error("getSessionMessages 暂未迁到 WS RPC（用 getSession 拿全部 messages）");
  }

  // ── /now state-derivation engine ──

  async listNowCards(): Promise<NowCard[]> {
    return this.call("now.cards");
  }

  async dismissNowCard(cardId: string): Promise<{ ok: true }> {
    return this.call("now.dismissCard", { id: cardId });
  }

  // ── Requirements ──

  async createRequirement(body: {
    project_id?: string;
    workspace_id?: string | null;
    title: string;
    spec_md?: string;
    chat_session_id?: string | null;
  }): Promise<{ requirement: { id: string; status: string; title: string } }> {
    return this.call("requirements.create", body);
  }

  async extractRequirement(input: {
    raw_text: string;
    project_id: string;
    workspace_id?: string | null;
  }): Promise<{ title: string; spec_md: string }> {
    return this.call("requirements.extract", input, { timeoutMs: 300_000 });
  }

  async updateRequirement(id: string, body: {
    title?: string;
    spec_md?: string;
    workspace_id?: string | null;
    workflow?: string | null;
  }): Promise<{ requirement: { id: string; status: string; title: string } }> {
    return this.call("requirements.update", { id, ...body });
  }

  async getRequirement(id: string): Promise<{ requirement: Requirement }> {
    return this.call("requirements.get", { id });
  }

  async listRequirements(filters?: {
    status?: string;
    project_id?: string;
    workspace_id?: string;
  }): Promise<{ requirements: Requirement[] }> {
    return this.call("requirements.list", filters ?? {});
  }

  /** 优雅停机：daemon 自己关 socket 后 exit 0（避免 Windows 硬杀产生 zombie LISTEN） */
  async shutdownDaemon(): Promise<{ ok: boolean; scheduled_in_ms: number }> {
    return this.call("daemon.shutdown", undefined, { timeoutMs: 3000 });
  }

  /** 终态任务的结果概览（含 terminal_reason / rejection_*）；非终态任务抛 NOT_FOUND */
  async getTaskOutcome(id: string): Promise<import("../daemon/task-outcome").TaskOutcome> {
    return this.call("tasks.outcome", { id });
  }
}
