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
  get cancelTask() { return this.http.cancelTask.bind(this.http); }
  get getTaskLogs() { return this.http.getTaskLogs.bind(this.http); }
  get getSubTasks() { return this.http.getSubTasks.bind(this.http); }
  get listWorkflows() { return this.http.listWorkflows.bind(this.http); }
  get getWorkflow() { return this.http.getWorkflow.bind(this.http); }
  get getWorkflowGraph() { return this.http.getWorkflowGraph.bind(this.http); }

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
