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
import { getApiToken, shouldUseToken } from "./api-token";

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
// 本会话内是否曾成功建立过 WS 连接（onopen 至少触发过一次）。区分「首连 CONNECTING」(false)
// 与「被动掉线重连」(true)——两者 ws 都非 OPEN 但语义相反：首连必须等（保 9ed3042 首屏修复），
// 被动掉线该 fast-fail。单调：onopen 置 true，仅 disconnect/_resetWsSingletonForTest 复位。
let everConnected = false;

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
  // 浏览器 WebSocket API 不能自定义 header —— 局域网访问时把 token 放 query。
  // 本机回环 daemon 会自动豁免 token，shouldUseToken() 返回 false 跳过。
  let query = "";
  if (shouldUseToken()) {
    const token = getApiToken();
    if (token) query = `?token=${encodeURIComponent(token)}`;
  }
  return `${proto}//${location.host}/ws${query}`;
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
    everConnected = true;
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
  everConnected = false;
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

// daemon 主动 restart 进行中标志位。调用方（如 NetworkAccessCard）在触发
// daemon.restart 前后调 setRestarting(true/false)，期间所有新 rpcCall 直接
// fast-fail（不等 waitForOpen 5s），避免用户在重启窗口期发出的 mutation
// 卡 5s 才反馈 / optimistic UI 与真实状态长时间脱节。
let restarting = false;
export function setRestarting(value: boolean): void {
  restarting = value;
}
export function isRestarting(): boolean {
  return restarting;
}

/**
 * 发起 RPC 请求。ws 非 OPEN 时按连接阶段分叉：
 * - restarting（daemon 主动重启窗口，38ec63b）：立即 reject RESTARTING。
 * - 首连 CONNECTING（everConnected=false，页面刚打开）：waitForOpen 最多等 5s，避免"页面刚打开 →
 *   所有 RPC 一起 reject"的首屏假死（9ed3042）。
 * - 被动掉线（everConnected=true，曾连上后 daemon 崩/网抖/睡眠唤醒）：立即 fast-fail DISCONNECTED，
 *   不卡 5s（WEB-08）；UI 即时反馈，DaemonOfflineBanner 另行去抖显红条。
 */
export async function rpcCall<T = unknown>(method: string, params?: unknown, opts?: CallOptions): Promise<T> {
  if (restarting) {
    throw new RpcCallError("RESTARTING", "daemon 正在重启，请稍后再试");
  }
  ensureConnected();
  if (ws?.readyState !== WebSocket.OPEN) {
    if (!everConnected) {
      // 首连 CONNECTING：仍等，保住 9ed3042 首屏假死修复（硬红线）。
      const ok = await waitForOpen(5000);
      if (!ok) {
        throw new RpcCallError("DISCONNECTED", "WebSocket 未连接，等待超时");
      }
    } else {
      // 被动掉线（曾连上、非主动重启、当前断开/重连中）：立即 fast-fail，不卡 5s（WEB-08）。
      throw new RpcCallError("DISCONNECTED", "WebSocket 已断开（重连中）");
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
  everConnected = false;
}
