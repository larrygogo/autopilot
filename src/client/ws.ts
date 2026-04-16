import type { AutopilotEvent, ServerMessage, ClientMessage } from "../daemon/protocol";

// ──────────────────────────────────────────────
// WebSocket 客户端 — 自动重连 + 订阅管理
// ──────────────────────────────────────────────

export type ConnectionState = "connecting" | "connected" | "disconnected";

type EventHandler = (event: AutopilotEvent) => void;
type StateHandler = (state: ConnectionState) => void;

export class WsClient {
  private ws: WebSocket | null = null;
  private subscriptions = new Map<string, Set<EventHandler>>();
  private stateListeners = new Set<StateHandler>();
  private _state: ConnectionState = "disconnected";
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private shouldReconnect = true;
  private pendingSubscriptions = new Set<string>();

  constructor(private url: string) {}

  get state(): ConnectionState {
    return this._state;
  }

  connect(): void {
    if (this.ws) return;
    this.shouldReconnect = true;
    this._connect();
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setState("disconnected");
  }

  subscribe(channel: string, handler: EventHandler): () => void {
    let handlers = this.subscriptions.get(channel);
    if (!handlers) {
      handlers = new Set();
      this.subscriptions.set(channel, handlers);
      // 发送订阅消息
      this.pendingSubscriptions.add(channel);
      this.sendSubscriptions();
    }
    handlers.add(handler);

    // 返回取消订阅函数
    return () => {
      handlers!.delete(handler);
      if (handlers!.size === 0) {
        this.subscriptions.delete(channel);
        this.pendingSubscriptions.delete(channel);
        this.send({ type: "unsubscribe", channels: [channel] });
      }
    };
  }

  onStateChange(handler: StateHandler): () => void {
    this.stateListeners.add(handler);
    return () => this.stateListeners.delete(handler);
  }

  // ── Internal ──

  private _connect(): void {
    this.setState("connecting");

    try {
      this.ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.setState("connected");
      this.reconnectDelay = 1000;
      // 重新发送所有订阅
      this.sendSubscriptions();
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as ServerMessage;
        if (msg.type === "event") {
          this.dispatch(msg.event);
        }
      } catch {
        // 忽略解析错误
      }
    };

    this.ws.onclose = () => {
      this.ws = null;
      this.setState("disconnected");
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // onclose 会紧跟着触发
    };
  }

  private dispatch(event: AutopilotEvent): void {
    for (const [channel, handlers] of this.subscriptions) {
      // 简单匹配：通配符或精确匹配
      if (this.eventMatchesChannel(event, channel)) {
        for (const handler of handlers) {
          try {
            handler(event);
          } catch {
            // 忽略 handler 错误
          }
        }
      }
    }
  }

  private eventMatchesChannel(event: AutopilotEvent, channel: string): boolean {
    const [category, id] = channel.split(":");
    const eventCategory = event.type.split(":")[0];

    // daemon 频道特殊处理
    if (channel === "daemon") return eventCategory === "daemon";

    // watcher 事件映射到 task 频道
    const effectiveCategory = eventCategory === "watcher" ? "task" : eventCategory;
    if (category !== effectiveCategory) return false;

    // 通配符匹配
    if (id === "*") return true;

    // 精确 taskId 匹配
    const taskId =
      "taskId" in event.payload
        ? (event.payload as { taskId: string }).taskId
        : "task" in event.payload
          ? (event.payload as { task: { id: string } }).task.id
          : undefined;

    return taskId === id;
  }

  private sendSubscriptions(): void {
    const channels = [...this.subscriptions.keys()];
    if (channels.length > 0 && this._state === "connected") {
      this.send({ type: "subscribe", channels });
    }
  }

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private setState(state: ConnectionState): void {
    if (this._state === state) return;
    this._state = state;
    for (const handler of this.stateListeners) {
      try {
        handler(state);
      } catch {
        // 忽略
      }
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    if (this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect();
    }, this.reconnectDelay);

    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }
}
