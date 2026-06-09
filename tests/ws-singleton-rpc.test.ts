import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  ensureConnected,
  rpcCall,
  setRestarting,
  _resetWsSingletonForTest,
} from "../src/web/src/lib/ws-singleton";
import { RpcCallError } from "../src/web/src/lib/ws-rpc-client";

// bun 自带 WebSocket，测试须用 fake 覆盖 globalThis.WebSocket 再驱动 onopen/onclose。
class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static last: FakeWebSocket | null = null;
  readyState = 0; // CONNECTING
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: unknown) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_url: string) { FakeWebSocket.last = this; }
  send(): void { /* no-op */ }
  close(): void { this.readyState = 3; }
  // 测试驱动钩子
  _open(): void { this.readyState = 1; this.onopen?.(); }
  _close(): void { this.readyState = 3; this.onclose?.(); }
}

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

let realWS: typeof globalThis.WebSocket;
beforeEach(() => {
  realWS = globalThis.WebSocket;
  (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  FakeWebSocket.last = null;
  _resetWsSingletonForTest();
});
afterEach(() => {
  _resetWsSingletonForTest();
  (globalThis as { WebSocket: unknown }).WebSocket = realWS;
});

describe("ws-singleton rpcCall · 首连/被动断线/重启 三态", () => {
  it("INV-1 首连期（CONNECTING、从未连上）rpcCall 不立即 fast-fail，仍等待", async () => {
    ensureConnected(); // connect → new FakeWebSocket（CONNECTING），everConnected=false
    let settled = false;
    void rpcCall("noop").then(() => { settled = true; }, () => { settled = true; });
    await flush();
    expect(settled).toBe(false); // 还在 waitForOpen 等待，没被 fast-fail（保 9ed3042 首屏修复）
    // 清理：驱动 onopen 让 waitForOpen 清掉它的 5s 定时器，剩余 rpc pending 由 afterEach reset 收尾
    FakeWebSocket.last!._open();
    await flush();
  });

  it("INV-2 被动掉线（曾连上、当前断开、非 restarting）rpcCall 立即 fast-fail DISCONNECTED", async () => {
    ensureConnected();
    FakeWebSocket.last!._open();  // 连上：everConnected=true
    FakeWebSocket.last!._close(); // 被动掉线：ws=null、state=disconnected、排重连定时器
    let err: unknown = null;
    const t0 = Date.now();
    await rpcCall("noop").catch((e) => { err = e; });
    const elapsed = Date.now() - t0;
    expect(err).toBeInstanceOf(RpcCallError);
    expect((err as RpcCallError).code).toBe("DISCONNECTED");
    // 关键：fast-fail，不卡 waitForOpen 5s（现码会 ~5000ms → 此断言红，正是要修的）
    expect(elapsed).toBeLessThan(100);
  });

  it("INV-3 restarting 期 rpcCall 立即 reject RESTARTING（优先级最高，守 38ec63b）", async () => {
    ensureConnected();
    FakeWebSocket.last!._open(); // 即便已连上
    setRestarting(true);
    let err: unknown = null;
    await rpcCall("noop").catch((e) => { err = e; });
    expect(err).toBeInstanceOf(RpcCallError);
    expect((err as RpcCallError).code).toBe("RESTARTING");
    setRestarting(false);
  });
});
