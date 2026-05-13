import type { AutopilotEvent } from "../core/events";

// ──────────────────────────────────────────────
// Event Types — 事件类型已下沉到 core/events.ts
// 这里 re-export 保留既有 import 路径不破。
// ──────────────────────────────────────────────

export type { AutopilotEvent } from "../core/events";

// ──────────────────────────────────────────────
// WebSocket Protocol — Client ↔ Server 消息
// ──────────────────────────────────────────────

/** 客户端 → 服务端 */
export type ClientMessage =
  | { type: "subscribe"; channels: string[] }
  | { type: "unsubscribe"; channels: string[] }
  | { type: "ping" };

/** 服务端 → 客户端 */
export type ServerMessage =
  | { type: "connected"; version: string; pid: number }
  | { type: "event"; event: AutopilotEvent }
  | { type: "pong" };

// ──────────────────────────────────────────────
// API Response Types
// ──────────────────────────────────────────────

export interface DaemonStatus {
  version: string;
  uptime: number;
  pid: number;
  taskCounts: Record<string, number>;
}

export interface GraphNode {
  id: string;
  label: string;
  type: "initial" | "pending" | "running" | "terminal" | "other";
}

export interface GraphEdge {
  from: string;
  to: string;
  trigger: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  initialState: string;
  terminalStates: string[];
}

// ──────────────────────────────────────────────
// Channel Matching — 事件到订阅频道的映射
// ──────────────────────────────────────────────

/**
 * 根据事件类型返回匹配的频道列表。
 * 例如 task:created {taskId: "abc"} → ["task:abc", "task:*"]
 */
export function getChannelsForEvent(event: AutopilotEvent): string[] {
  const channels: string[] = [];
  const [category] = event.type.split(":");

  switch (category) {
    case "task": {
      channels.push("task:*");
      const taskId =
        "taskId" in event.payload
          ? event.payload.taskId
          : "task" in event.payload
            ? (event.payload as { task: { id: string } }).task.id
            : undefined;
      if (taskId) channels.push(`task:${taskId}`);
      break;
    }
    case "phase": {
      channels.push("phase:*");
      if ("taskId" in event.payload) {
        channels.push(`phase:${event.payload.taskId}`);
      }
      break;
    }
    case "log": {
      channels.push("log:*");
      if ("taskId" in event.payload && event.payload.taskId) {
        channels.push(`log:${event.payload.taskId}`);
      }
      break;
    }
    case "watcher": {
      channels.push("task:*");
      if ("taskId" in event.payload) {
        channels.push(`task:${event.payload.taskId}`);
      }
      break;
    }
    case "daemon":
    case "config":
    case "workflow": {
      channels.push("daemon");
      break;
    }
    case "schedule": {
      channels.push("schedule:*");
      break;
    }
    case "requirement": {
      channels.push("requirement:*");
      break;
    }
    case "provider": {
      channels.push("provider:*");
      break;
    }
    case "now": {
      channels.push("now:*");
      break;
    }
  }

  return channels;
}

/**
 * 检查订阅是否匹配某个频道。
 */
export function matchesSubscription(subscription: string, channel: string): boolean {
  return subscription === channel;
}
