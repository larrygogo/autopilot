import type { Task, TaskLog } from "../core/db";
import type { ChatMessage } from "../core/sessions";
import type { Schedule } from "../core/schedules";

// ──────────────────────────────────────────────
// Event Types — 核心模块发射的事件
// ──────────────────────────────────────────────

// 用内联 import("...") 引入 NowCard 类型，避免与 core/now-types.ts 形成顶层循环依赖
type _NowCardRef = import("../core/now-types").NowCard;

export type AutopilotEvent =
  | { type: "task:created"; payload: { task: Task } }
  | { type: "task:updated"; payload: { task: Task; fields: string[] } }
  | { type: "task:deleted"; payload: { taskId: string; parentTaskId: string | null } }
  | { type: "task:transition"; payload: { taskId: string; from: string; to: string; trigger: string } }
  | { type: "phase:started"; payload: { taskId: string; phase: string; label: string } }
  | { type: "phase:completed"; payload: { taskId: string; phase: string } }
  | { type: "phase:awaiting"; payload: { taskId: string; phase: string } }
  | { type: "phase:error"; payload: { taskId: string; phase: string; error: string } }
  | { type: "task:asking"; payload: { taskId: string; phase: string; question: string } }
  | { type: "task:answered"; payload: { taskId: string; phase: string } }
  | { type: "log:entry"; payload: { taskId?: string; phase: string; level: string; message: string; timestamp: string } }
  | { type: "watcher:recovery"; payload: { taskId: string; phase: string; fromStatus: string; toStatus: string } }
  | { type: "daemon:status"; payload: { version: string; uptime: number; pid: number; taskCounts: Record<string, number> } }
  | { type: "config:updated"; payload: Record<string, never> }
  | { type: "workflow:reloaded"; payload: Record<string, never> }
  | { type: "chat:delta"; payload: { sessionId: string; delta: string } }
  | { type: "chat:complete"; payload: { sessionId: string; message: ChatMessage } }
  | { type: "chat:error"; payload: { sessionId: string; error: string } }
  | { type: "schedule:created"; payload: { schedule: Schedule } }
  | { type: "schedule:updated"; payload: { schedule: Schedule } }
  | { type: "schedule:deleted"; payload: { scheduleId: string } }
  | { type: "schedule:fired"; payload: { schedule: Schedule; taskId: string } }
  | { type: "requirement:status-changed"; payload: { id: string; from: string; to: string } }
  | { type: "requirement:questions-updated"; payload: { id: string } }
  | { type: "requirement:all-questions-resolved"; payload: { id: string } }
  // /now 推送事件
  | { type: "now:card_added"; payload: { card: _NowCardRef } }
  | { type: "now:card_updated"; payload: { id: string; patch: Partial<_NowCardRef> } }
  | { type: "now:card_removed"; payload: { id: string; reason: "resolved" | "dismissed" } }
  | { type: "now:snapshot"; payload: { cards: _NowCardRef[] } };

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
            ? (event.payload as { task: Task }).task.id
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
