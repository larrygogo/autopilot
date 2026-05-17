/**
 * 全局唯一 WS 连接 — 让所有组件 / api 调用共享单一 socket。
 *
 * 之前 useWebSocket() 每个 hook 实例独立建 ws → 一个 page 上同时跑 6+ 个连接
 * （App + RunningTasksIndicator + RequirementDetail + ...），既浪费 daemon 资源
 * 又让 useApi 这种 module-level 单例 object 拿不到连接。
 *
 * 此 module 维护一个真·进程内单例：
 *   - 第一次有人调用 ensureConnected() 或订阅时才建连接（lazy）
 *   - 自动重连（指数退避 1s → 30s）
 *   - 事件订阅分发到 channel listener
 *   - RPC call() 在同一 socket 上跑
 *
 * useWebSocket hook 退化为对此 singleton 的 React reactive wrapper；
 * useApi 内部直接 import { rpcCall } 走 singleton。
 *
 * 测试场景：在 jsdom / node 下 globalThis.WebSocket 没有时，模块行为是
 * `ensureConnected` no-op，订阅 / 调用都不触发；测试方可以注入自己的 WS 实现。
 */

import { WsRpcClient, RpcCallError, type CallOptions } from "./ws-rpc-client";

export type ConnectionState = "connecting" | "connected" | "disconnected";

type EventHandler = (event: any) => void;
type StateListener = (state: ConnectionState) => void;

// ──────────────────────────────────────────────
// State
// ──────────────────────────────────────────────

let ws: WebSocket | null = null;
let state: ConnectionState = "disconnected";
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1000;
let shouldReconnect = true;
let started = false;

const channelHandlers = new Map<string, Set<EventHandler>>();
const stateListeners = new Set<StateListener>();

const rpc = new WsRpcClient(
  (raw) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket 未连接");
    }
    ws.send(raw);
  },
  () => ws?.readyState === WebSocket.OPEN,
);

// ──────────────────────────────────────────────
// 内部辅助
// ──────────────────────────────────────────────

function setState(next: ConnectionState): void {
  if (state === next) return;
  state = next;
  for (const l of stateListeners) {
    try { l(state); } catch { /* listener 异常不影响别人 */ }
  }
}

function getWsUrl(): string {
  if (typeof location === "undefined") return "ws://127.0.0.1:6180/ws"; // 非浏览器兜底
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

function sendSubscriptions(): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const channels = [...channelHandlers.keys()];
  if (channels.length > 0) {
    // 用 RPC method channels.subscribe（OpenClaw 风），失败容错——握手中不期望响应阻塞
    rpc.call("channels.subscribe", { channels }).catch(() => { /* 静默 */ });
  }
}

function getTaskId(event: any): string | undefined {
  return event.payload?.taskId ?? event.payload?.task?.id;
}

function dispatchEvent(event: any): void {
  for (const [channel, handlers] of channelHandlers) {
    const [cat, id] = channel.split(":");
    const eventCat = event.type.split(":")[0];
    const effectiveCat = eventCat === "watcher" ? "task" : eventCat;
    if (channel === "daemon" && eventCat === "daemon") {
      handlers.forEach((h) => h(event));
    } else if (cat === effectiveCat && (id === "*" || getTaskId(event) === id)) {
      handlers.forEach((h) => h(event));
    }
  }
}

function connect(): void {
  if (ws) return;
  if (typeof globalThis.WebSocket === "undefined") return; // 非浏览器环境跳过
  setState("connecting");
  const sock = new globalThis.WebSocket(getWsUrl());
  ws = sock;

  sock.onopen = () => {
    setState("connected");
    reconnectDelay = 1000;
    sendSubscriptions();
  };

  sock.onmessage = (e: MessageEvent) => {
    try {
      const msg = JSON.parse(typeof e.data === "string" ? e.data : String(e.data));
      if (msg.type === "res") {
        rpc.handleResFrame(msg);
        return;
      }
      if (msg.type === "event") {
        dispatchEvent(msg.event);
      }
    } catch { /* ignore */ }
  };

  sock.onclose = () => {
    ws = null;
    setState("disconnected");
    rpc.rejectAllPending("DISCONNECTED", "WebSocket 已断开");
    if (!shouldReconnect) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  };

  sock.onerror = () => {
    // onclose 会接着触发；这里不重复处理
  };
}

// ──────────────────────────────────────────────
// 公开 API
// ──────────────────────────────────────────────

/** 触发首次连接（lazy）。重复调用幂等。 */
export function ensureConnected(): void {
  if (started) return;
  started = true;
  shouldReconnect = true;
  connect();
}

/** 主动断开（一般给测试用） */
export function disconnect(): void {
  shouldReconnect = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const sock = ws;
  ws = null;
  if (sock) {
    sock.onclose = null;
    try { sock.close(); } catch { /* ignore */ }
  }
  setState("disconnected");
  rpc.rejectAllPending("DISCONNECTED", "客户端主动断开");
  started = false;
}

export function getConnectionState(): ConnectionState {
  return state;
}

/** 订阅状态变化（hook wrapper 用） */
export function addStateListener(listener: StateListener): () => void {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

/** 订阅频道事件。返回 unsubscribe 函数。 */
export function subscribeChannel(channel: string, handler: EventHandler): () => void {
  ensureConnected();
  let handlers = channelHandlers.get(channel);
  if (!handlers) {
    handlers = new Set();
    channelHandlers.set(channel, handlers);
    if (ws?.readyState === WebSocket.OPEN) {
      // P4: 用 RPC method channels.subscribe（OpenClaw 风），不阻塞调用方
      rpc.call("channels.subscribe", { channels: [channel] }).catch(() => { /* 静默 */ });
    }
  }
  handlers.add(handler);
  return () => {
    handlers!.delete(handler);
    if (handlers!.size === 0) {
      channelHandlers.delete(channel);
      // 取消订阅也走 RPC method
      if (ws?.readyState === WebSocket.OPEN) {
        rpc.call("channels.unsubscribe", { channels: [channel] }).catch(() => { /* 静默 */ });
      }
    }
  };
}

/**
 * 等待 ws 进入 OPEN，最长 timeoutMs 毫秒。
 * - 已 OPEN：立刻 resolve(true)
 * - 在超时窗内连上：resolve(true)
 * - 超时仍未连上：resolve(false)（调用方自行 fast-fail）
 */
function waitForOpen(timeoutMs: number): Promise<boolean> {
  if (ws?.readyState === WebSocket.OPEN) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      stateListeners.delete(listener);
      resolve(false);
    }, timeoutMs);
    const listener: StateListener = (s) => {
      if (s === "connected") {
        clearTimeout(timer);
        stateListeners.delete(listener);
        resolve(true);
      }
    };
    stateListeners.add(listener);
  });
}

/**
 * 发起 RPC 请求。
 * 首次访问页面时 ws 通常还在 CONNECTING，先等一段时间让连接 ready 再发，
 * 避免"页面刚打开 → 所有 RPC 一起 reject DISCONNECTED"的假死。
 * 真断线场景：等不到 OPEN 仍会 reject DISCONNECTED，行为不变。
 */
export async function rpcCall<T = unknown>(method: string, params?: unknown, opts?: CallOptions): Promise<T> {
  ensureConnected();
  if (ws?.readyState !== WebSocket.OPEN) {
    const ok = await waitForOpen(5000);
    if (!ok) {
      throw new RpcCallError("DISCONNECTED", "WebSocket 未连接，等待超时");
    }
  }
  return rpc.call<T>(method, params, opts);
}

/** 测试 / 调试用：当前 pending RPC 数量 */
export function rpcPendingCount(): number {
  return rpc.pendingCount();
}

/** 测试专用：重置全局状态 */
export function _resetWsSingletonForTest(): void {
  disconnect();
  channelHandlers.clear();
  stateListeners.clear();
  rpc.rejectAllPending("RESET", "测试重置");
  state = "disconnected";
  reconnectDelay = 1000;
  started = false;
}
