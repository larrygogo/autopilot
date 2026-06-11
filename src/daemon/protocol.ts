import type { AutopilotEvent } from "../core/events";

// ──────────────────────────────────────────────
// Event Types — 事件类型已下沉到 core/events.ts
// 这里 re-export 保留既有 import 路径不破。
// ──────────────────────────────────────────────

export type { AutopilotEvent } from "../core/events";

// ──────────────────────────────────────────────
// WebSocket Protocol — Client ↔ Server 消息
//
// 参考 OpenClaw Gateway 协议（三种 frame）：
//   - req: 客户端发请求，用 id 关联响应；method 路由到 handler
//   - res: 服务端响应，复制 id，ok=true 时带 payload，false 时带 error
//   - event: 服务端主动推送（订阅触发），跟 RPC 响应无 id 关联
//
// 保留 legacy subscribe/unsubscribe/ping，过渡期共存。新代码统一走 req/res。
// ──────────────────────────────────────────────

/** RPC 错误对象 — code 是机器友好枚举（NOT_FOUND / INVALID_PARAM / INTERNAL），message 是人话 */
export interface RpcError {
  code: string;
  message: string;
}

/** 客户端 → 服务端 */
export type ClientMessage =
  | { type: "subscribe"; channels: string[] }
  | { type: "unsubscribe"; channels: string[] }
  | { type: "ping" }
  /** RPC 请求：id 由客户端生成（per-conn 单调递增），method 是注册名（如 "listTasks"） */
  | { type: "req"; id: number | string; method: string; params?: unknown };

/** 服务端 → 客户端 */
export type ServerMessage =
  | { type: "connected"; version: string; pid: number }
  | { type: "event"; event: AutopilotEvent }
  | { type: "pong" }
  /** RPC 响应：id 复制自请求；ok=true 时带 payload，false 时带 error */
  | { type: "res"; id: number | string; ok: true; payload?: unknown }
  | { type: "res"; id: number | string; ok: false; error: RpcError };

// ──────────────────────────────────────────────
// API Response Types
// ──────────────────────────────────────────────

export interface DaemonStatus {
  version: string;
  /** 当前代码的 git 短 SHA；非 git 仓库或 git 不可用时为 "dev" */
  git_sha: string;
  /** daemon 进程启动时间 (ISO 8601)，配合 uptime 让 web 能展示「启动于 X 至今」 */
  started_at_iso: string;
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
    case "projects": {
      channels.push("projects:*");
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
    case "notification": {
      channels.push("notification:*");
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
