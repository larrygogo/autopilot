/**
 * 浏览器侧 WS RPC 客户端核心 — 不耦合 React，方便单测。
 *
 * 跟服务端协议（src/daemon/protocol.ts）对齐：发 req frame，按 id 关联 res frame。
 * 客户端维护 per-conn 单调递增 id 计数器 + pending map 实现 Promise 风格 API。
 *
 * 用法（在 useWebSocket 里集成）：
 *   const rpc = new WsRpcClient(raw => ws.send(raw), () => ws.readyState === OPEN);
 *   ws.onmessage = e => { ...; if (msg.type === "res") rpc.handleResFrame(msg); };
 *   ws.onclose = () => rpc.rejectAllPending("DISCONNECTED");
 *
 *   await rpc.call("tasks.list", { limit: 10 });
 */

/** RPC 调用失败统一错误类（区别于业务自定义 Error） */
export class RpcCallError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "RpcCallError";
  }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (err: RpcCallError) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

/** 服务端 res frame 形状（跟 daemon/protocol.ts 对齐） */
export interface ResFrame {
  type: "res";
  id: number | string;
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string };
}

export interface CallOptions {
  /** 默认 30000ms；触发后 pending 被 evict 并 reject TIMEOUT */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class WsRpcClient {
  private pending = new Map<number, Pending>();
  private idCounter = 0;

  constructor(
    /** 发送原始字符串到底层 ws；ws 没 open 时由调用方决定行为（call 内部已检查 isOpen） */
    private readonly sendRaw: (data: string) => void,
    /** 询问底层 ws 当前是否处于可发送状态 */
    private readonly isOpen: () => boolean,
  ) {}

  /**
   * 发起 RPC。返回 Promise<payload>。
   * 调用时 ws 未 open 立刻 reject DISCONNECTED；超时 / 服务端返回 error / 客户端断线均 reject。
   */
  call<T = unknown>(method: string, params?: unknown, opts?: CallOptions): Promise<T> {
    const id = ++this.idCounter;
    return new Promise<T>((resolve, reject) => {
      if (!this.isOpen()) {
        reject(new RpcCallError("DISCONNECTED", "WebSocket 未连接，无法发起 RPC"));
        return;
      }
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new RpcCallError("TIMEOUT", `RPC 超时（method=${method}, ${timeoutMs}ms）`));
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        method,
      });
      try {
        this.sendRaw(JSON.stringify({ type: "req", id, method, params }));
      } catch (e: unknown) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new RpcCallError("SEND_FAILED", e instanceof Error ? e.message : String(e)));
      }
    });
  }

  /**
   * 服务端 res frame 路由到 pending Promise。
   * 收到未知 id 静默忽略（可能是超时已 evict 的旧响应）。
   */
  handleResFrame(msg: ResFrame): void {
    const id = typeof msg.id === "number" ? msg.id : Number(msg.id);
    if (!Number.isFinite(id)) return;
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    if (msg.ok) {
      p.resolve(msg.payload);
    } else {
      const err = msg.error ?? { code: "UNKNOWN", message: "无 error 字段" };
      p.reject(new RpcCallError(err.code, err.message));
    }
  }

  /**
   * 当前 pending 数量（测试 / 调试用）。
   */
  pendingCount(): number {
    return this.pending.size;
  }

  /**
   * ws 断开时把所有 pending 都 reject，避免调用方永等。
   */
  rejectAllPending(code: string, message: string): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new RpcCallError(code, message));
    }
    this.pending.clear();
  }
}
