import type { ServerWebSocket } from "bun";
import { VERSION } from "../index";
import type { AutopilotEvent, ClientMessage, ServerMessage } from "./protocol";
import { getChannelsForEvent } from "./protocol";

// ──────────────────────────────────────────────
// WebSocket 连接管理器
// ──────────────────────────────────────────────

interface WsClient {
  subscriptions: Set<string>;
}

class WebSocketManager {
  private clients = new Map<ServerWebSocket<unknown>, WsClient>();

  register(ws: ServerWebSocket<unknown>): void {
    this.clients.set(ws, { subscriptions: new Set() });
    const msg: ServerMessage = { type: "connected", version: VERSION, pid: process.pid };
    ws.send(JSON.stringify(msg));
  }

  unregister(ws: ServerWebSocket<unknown>): void {
    this.clients.delete(ws);
  }

  handleMessage(ws: ServerWebSocket<unknown>, raw: string | Buffer): void {
    const client = this.clients.get(ws);
    if (!client) return;

    let msg: ClientMessage;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : raw.toString()) as ClientMessage;
    } catch {
      return;
    }

    switch (msg.type) {
      case "subscribe":
        for (const ch of msg.channels) client.subscriptions.add(ch);
        break;
      case "unsubscribe":
        for (const ch of msg.channels) client.subscriptions.delete(ch);
        break;
      case "ping": {
        const pong: ServerMessage = { type: "pong" };
        ws.send(JSON.stringify(pong));
        break;
      }
    }
  }

  broadcast(event: AutopilotEvent): void {
    if (this.clients.size === 0) return;

    const channels = getChannelsForEvent(event);
    const payload = JSON.stringify({ type: "event", event } satisfies ServerMessage);

    for (const [ws, client] of this.clients) {
      const match = channels.some((ch) => client.subscriptions.has(ch));
      if (match) {
        try {
          ws.send(payload);
        } catch {
          // 连接已断开，忽略
        }
      }
    }
  }

  get connectionCount(): number {
    return this.clients.size;
  }
}

export const wsManager = new WebSocketManager();
