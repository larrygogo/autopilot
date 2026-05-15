/**
 * Node/Bun 侧的 WS RPC 调用器 — 给 CLI 用的"one-shot 风"客户端。
 *
 * 跟浏览器 ws-singleton 不一样：CLI 是一次性命令，进程结束 socket 自然清理。
 * 这里 lazy 建立单一连接，所有 call 复用；客户端代码不关心生命周期，
 * 进程退出 OS 关 socket。
 *
 * 协议跟服务端 src/daemon/protocol.ts 对齐：req/res frame，id 关联。
 */

export class WsRpcError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "WsRpcError";
  }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 把 http(s) URL 转 ws(s) + 拼 /ws 路径 */
export function toWsUrl(baseUrl: string): string {
  const noTrailing = baseUrl.replace(/\/+$/, "");
  const wsBase = noTrailing.replace(/^http(s?):/, "ws$1:");
  return `${wsBase}/ws`;
}

export class WsRpcCaller {
  private ws: WebSocket | null = null;
  private pending = new Map<number, Pending>();
  private idCounter = 0;
  private connecting: Promise<void> | null = null;
  /** 默认 60s 超时（CLI 调 LLM 类 method 也够） */
  private defaultTimeoutMs = 60_000;

  constructor(private readonly wsUrl: string) {}

  /** 设默认超时（毫秒）。LLM 类调用建议 5min。 */
  setDefaultTimeout(ms: number): void {
    this.defaultTimeoutMs = ms;
  }

  async call<T>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<T> {
    await this.ensureConnected();
    if (!this.ws) throw new WsRpcError("DISCONNECTED", "WS 未连接");
    const id = ++this.idCounter;
    const timeoutMs = opts?.timeoutMs ?? this.defaultTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new WsRpcError("TIMEOUT", `RPC 超时 method=${method} ${timeoutMs}ms`));
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      try {
        this.ws!.send(JSON.stringify({ type: "req", id, method, params }));
      } catch (e: unknown) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new WsRpcError("SEND_FAILED", e instanceof Error ? e.message : String(e)));
      }
    });
  }

  /** 主动关闭连接（CLI 通常不需要调，进程退出会自动关） */
  close(): void {
    if (this.ws) {
      const w = this.ws;
      this.ws = null;
      try { w.close(); } catch { /* ignore */ }
    }
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new WsRpcError("DISCONNECTED", "WS 已主动关闭"));
    }
    this.pending.clear();
  }

  private async ensureConnected(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const onError = (): void => {
        this.connecting = null;
        reject(new WsRpcError("CONNECT_FAILED", `连接失败：${this.wsUrl}（daemon 是否在运行？）`));
      };
      ws.onerror = onError;
      ws.onopen = () => {
        this.connecting = null;
        resolve();
      };
      ws.onmessage = (e: MessageEvent) => this.onFrame(typeof e.data === "string" ? e.data : String(e.data));
      ws.onclose = () => {
        this.ws = null;
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(new WsRpcError("DISCONNECTED", "WS 连接已关闭"));
        }
        this.pending.clear();
      };
    });
    return this.connecting;
  }

  private onFrame(raw: string): void {
    let msg: { type?: string; id?: number; ok?: boolean; payload?: unknown; error?: { code: string; message: string } };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type !== "res" || typeof msg.id !== "number") return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    if (msg.ok) {
      p.resolve(msg.payload);
    } else {
      const err = msg.error ?? { code: "UNKNOWN", message: "无 error 字段" };
      p.reject(new WsRpcError(err.code, err.message));
    }
  }
}
