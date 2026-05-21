import { HttpClient } from "./http";
import { WsClient } from "./ws";
import type { ConnectionState } from "./ws";
import type { AutopilotEvent } from "../daemon/protocol";

// ──────────────────────────────────────────────
// AutopilotClient — 统一客户端（HTTP + WebSocket）
// ──────────────────────────────────────────────

export const DEFAULT_PORT = 6180;
export const DEFAULT_HOST = "127.0.0.1";

export interface ClientOptions {
  host?: string;
  port?: number;
}

export class AutopilotClient {
  public readonly http: HttpClient;
  public readonly ws: WsClient;

  constructor(opts?: ClientOptions) {
    const host = opts?.host ?? DEFAULT_HOST;
    const port = opts?.port ?? DEFAULT_PORT;
    this.http = new HttpClient(`http://${host}:${port}`);
    this.ws = new WsClient(`ws://${host}:${port}/ws`);
  }

  // ── 便捷方法：代理 HTTP ──

  get getStatus() { return this.http.getStatus.bind(this.http); }
  get listTasks() { return this.http.listTasks.bind(this.http); }
  get getTask() { return this.http.getTask.bind(this.http); }
  get startTask() { return this.http.startTask.bind(this.http); }
  get startAdHocTask() { return this.http.startAdHocTask.bind(this.http); }
  get cancelTask() { return this.http.cancelTask.bind(this.http); }
  get sendTaskPrompt() { return this.http.sendTaskPrompt.bind(this.http); }
  get getTaskLogs() { return this.http.getTaskLogs.bind(this.http); }
  get getSubTasks() { return this.http.getSubTasks.bind(this.http); }
  get listWorkflows() { return this.http.listWorkflows.bind(this.http); }
  get getWorkflow() { return this.http.getWorkflow.bind(this.http); }
  get getWorkflowGraph() { return this.http.getWorkflowGraph.bind(this.http); }
  get getWorkflowYaml() { return this.http.getWorkflowYaml.bind(this.http); }
  get saveWorkflowYaml() { return this.http.saveWorkflowYaml.bind(this.http); }
  get createWorkflow() { return this.http.createWorkflow.bind(this.http); }
  get deleteWorkflow() { return this.http.deleteWorkflow.bind(this.http); }
  get exportWorkflow() { return this.http.exportWorkflow.bind(this.http); }
  get chat() { return this.http.chat.bind(this.http); }
  get listSessions() { return this.http.listSessions.bind(this.http); }
  get getSession() { return this.http.getSession.bind(this.http); }
  get deleteSession() { return this.http.deleteSession.bind(this.http); }
  get getSessionMessages() { return this.http.getSessionMessages.bind(this.http); }
  get listNowCards() { return this.http.listNowCards.bind(this.http); }
  get dismissNowCard() { return this.http.dismissNowCard.bind(this.http); }
  get createRequirement() { return this.http.createRequirement.bind(this.http); }
  get extractRequirement() { return this.http.extractRequirement.bind(this.http); }
  get listProjects() { return this.http.listProjects.bind(this.http); }
  get getProject() { return this.http.getProject.bind(this.http); }
  get createProject() { return this.http.createProject.bind(this.http); }
  get updateProject() { return this.http.updateProject.bind(this.http); }
  get deleteProject() { return this.http.deleteProject.bind(this.http); }
  get listCodebases() { return this.http.listCodebases.bind(this.http); }
  get getCodebase() { return this.http.getCodebase.bind(this.http); }
  get createCodebase() { return this.http.createCodebase.bind(this.http); }
  get deleteCodebase() { return this.http.deleteCodebase.bind(this.http); }
  get healthcheckCodebase() { return this.http.healthcheckCodebase.bind(this.http); }

  // ── 便捷方法：代理 WebSocket ──

  connect(): void { this.ws.connect(); }
  disconnect(): void { this.ws.disconnect(); }
  subscribe(channel: string, handler: (event: AutopilotEvent) => void): () => void {
    return this.ws.subscribe(channel, handler);
  }
  onStateChange(handler: (state: ConnectionState) => void): () => void {
    return this.ws.onStateChange(handler);
  }
  get connectionState(): ConnectionState { return this.ws.state; }
}

export { HttpClient } from "./http";
export { WsClient } from "./ws";
export type { ConnectionState } from "./ws";
export type { AutopilotEvent } from "../daemon/protocol";
