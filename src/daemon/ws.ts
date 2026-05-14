import type { ServerWebSocket } from "bun";
import { VERSION } from "../index";
import type { AutopilotEvent, ClientMessage, ServerMessage } from "./protocol";
import { getChannelsForEvent } from "./protocol";

// ──────────────────────────────────────────────
// WebSocket 连接管理器
// ──────────────────────────────────────────────

/**
 * Snapshot 提供器：客户端订阅某频道时，业务模块可注册回调，
 * 返回一条 snapshot 事件让 daemon 主动推给新订阅者。
 *
 * 实现 WS-only 数据流：客户端不靠 HTTP fetch 拿初始状态，
 * 而是订阅频道 + daemon 推 snapshot + 后续推增量。
 */
export type SnapshotProvider = (channel: string) => AutopilotEvent | null;
const _snapshotProviders: SnapshotProvider[] = [];

export function registerSnapshotProvider(p: SnapshotProvider): void {
  _snapshotProviders.push(p);
}

export function _resetSnapshotProvidersForTest(): void {
  _snapshotProviders.length = 0;
}

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
        for (const ch of msg.channels) {
          client.subscriptions.add(ch);
          // 触发 snapshot 推送：业务模块通过 registerSnapshotProvider 注册回调
          for (const provider of _snapshotProviders) {
            try {
              const snapshot = provider(ch);
              if (snapshot) {
                ws.send(JSON.stringify({ type: "event", event: snapshot } satisfies ServerMessage));
              }
            } catch {
              // snapshot 提供器异常不应阻塞订阅
            }
          }
        }
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
