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
  get shutdownDaemon() { return this.http.shutdownDaemon.bind(this.http); }
  get listTasks() { return this.http.listTasks.bind(this.http); }
  get getTask() { return this.http.getTask.bind(this.http); }
  get startTask() { return this.http.startTask.bind(this.http); }
  get startAdHocTask() { return this.http.startAdHocTask.bind(this.http); }
  get cancelTask() { return this.http.cancelTask.bind(this.http); }
  get sendTaskPrompt() { return this.http.sendTaskPrompt.bind(this.http); }
  get getTaskLogs() { return this.http.getTaskLogs.bind(this.http); }
  get listWorkflows() { return this.http.listWorkflows.bind(this.http); }
  get getWorkflow() { return this.http.getWorkflow.bind(this.http); }
  get getWorkflowGraph() { return this.http.getWorkflowGraph.bind(this.http); }
  get getWorkflowSpec() { return this.http.getWorkflowSpec.bind(this.http); }
  get getWorkflowYaml() { return this.http.getWorkflowYaml.bind(this.http); }
  get saveWorkflowSpec() { return this.http.saveWorkflowSpec.bind(this.http); }
  get saveWorkflowYaml() { return this.http.saveWorkflowYaml.bind(this.http); }
  get importWorkflow() { return this.http.importWorkflow.bind(this.http); }
  get deleteWorkflow() { return this.http.deleteWorkflow.bind(this.http); }
  get exportWorkflow() { return this.http.exportWorkflow.bind(this.http); }
  get chat() { return this.http.chat.bind(this.http); }
  get listSessions() { return this.http.listSessions.bind(this.http); }
  get getSession() { return this.http.getSession.bind(this.http); }
  get deleteSession() { return this.http.deleteSession.bind(this.http); }
  get getSessionMessages() { return this.http.getSessionMessages.bind(this.http); }
  get setRequirementWorkspaces() { return this.http.setRequirementWorkspaces.bind(this.http); }
  get transitionRequirement() { return this.http.transitionRequirement.bind(this.http); }
  get listRequirementSubPrs() { return this.http.listRequirementSubPrs.bind(this.http); }
  get listRequirementDeliveries() { return this.http.listRequirementDeliveries.bind(this.http); }
  get addRequirementFeedback() { return this.http.addRequirementFeedback.bind(this.http); }
  get listRequirementComments() { return this.http.listRequirementComments.bind(this.http); }
  get answerRequirementQuestion() { return this.http.answerRequirementQuestion.bind(this.http); }
  get enqueueRequirement() { return this.http.enqueueRequirement.bind(this.http); }
  get listNotifications() { return this.http.listNotifications.bind(this.http); }
  get notificationUnreadCount() { return this.http.notificationUnreadCount.bind(this.http); }
  get markNotificationsRead() { return this.http.markNotificationsRead.bind(this.http); }
  get markAllNotificationsRead() { return this.http.markAllNotificationsRead.bind(this.http); }
  get dismissNotification() { return this.http.dismissNotification.bind(this.http); }
  get createRequirement() { return this.http.createRequirement.bind(this.http); }
  get updateRequirement() { return this.http.updateRequirement.bind(this.http); }
  get getRequirement() { return this.http.getRequirement.bind(this.http); }
  get listRequirements() { return this.http.listRequirements.bind(this.http); }
  get getTaskOutcome() { return this.http.getTaskOutcome.bind(this.http); }
  get extractRequirement() { return this.http.extractRequirement.bind(this.http); }
  get listProjects() { return this.http.listProjects.bind(this.http); }
  get getProject() { return this.http.getProject.bind(this.http); }
  get createProject() { return this.http.createProject.bind(this.http); }
  get createProjectWithWorkspace() { return this.http.createProjectWithWorkspace.bind(this.http); }
  get updateProject() { return this.http.updateProject.bind(this.http); }
  get deleteProject() { return this.http.deleteProject.bind(this.http); }
  get listWorkspaces() { return this.http.listWorkspaces.bind(this.http); }
  get getWorkspace() { return this.http.getWorkspace.bind(this.http); }
  get createWorkspace() { return this.http.createWorkspace.bind(this.http); }
  get updateWorkspace() { return this.http.updateWorkspace.bind(this.http); }
  get deleteWorkspace() { return this.http.deleteWorkspace.bind(this.http); }
  get healthcheckWorkspace() { return this.http.healthcheckWorkspace.bind(this.http); }

  // ── 便捷方法：代理 WebSocket ──

  /** 关闭底层连接（RPC WS + 订阅 WS）。短命 CLI 调完即走时用，防进程挂存活连接。 */
  close(): void {
    try { this.http.close(); } catch { /* ignore */ }
    try { this.ws.disconnect(); } catch { /* ignore */ }
  }

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
