# WEB-08：Web WS 被动断线 fast-fail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 引入单调 `everConnected` 标志，让「被动掉线 backoff」期的 `rpcCall` 立即 fast-fail（不卡 waitForOpen 5s），同时保住「首连 CONNECTING」期仍等待（不回归 9ed3042 首屏假死）。

**Architecture:** `src/web/src/lib/ws-singleton.ts` 加 `let everConnected = false`（onopen 置 true、disconnect/reset 复位）。`rpcCall` 在「ws 非 OPEN 且非 restarting」时按 everConnected 分叉：`false`(首连)→`waitForOpen(5000)`；`true`(被动掉线)→同步 throw `DISCONNECTED`。新建 ws-singleton 单测，注入 fake `globalThis.WebSocket` 黑盒驱动三态。

**Tech Stack:** TypeScript strict + Bun（bun 自带 WebSocket，测试须覆盖 `globalThis.WebSocket`）+ React。

**偏离设计稿**：spec 的两阶段（先加标志零行为变更 → 再切 fast-fail）是为**部署中间态**安全；本次 inline 单提交不部署中间态，按 **TDD 一个 task**（写测试 → INV-2 红 → 实现 → 绿）更干净。其余遵循 spec `specs/2026-06-09-ws-passive-disconnect-fastfail-design.md`。

---

## Task 1：everConnected 区分首连/被动断线 + rpcCall fast-fail（TDD）

**Files:** Modify `src/web/src/lib/ws-singleton.ts`；Create `tests/ws-singleton-rpc.test.ts`

- [ ] **Step 1: 写测试（含 fake WebSocket 注入 + INV-1/2/3）**

新建 `tests/ws-singleton-rpc.test.ts`：

```ts
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
    await rpcCall("noop").catch((e) => { err = e; });
    expect(err).toBeInstanceOf(RpcCallError);
    expect((err as RpcCallError).code).toBe("DISCONNECTED"); // 同步立即，不卡 5s
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
```

- [ ] **Step 2: 跑测试确认 INV-2 红、INV-1/INV-3 绿**

Run: `bun test tests/ws-singleton-rpc.test.ts`
Expected: INV-1 PASS（现码对所有非 OPEN 都 waitForOpen 等待）、INV-3 PASS（restarting 检查已存在）、**INV-2 FAIL**（现码被动掉线也走 `waitForOpen(5000)`，不会立即 reject——`await rpcCall` 会卡 5s 后才 reject，测试在 reject 前已 await 完成？实际是 await 会等满 5s 才拿到 err，测试超时或耗时异常）。
> 注：若 INV-2 表现为「测试卡 5s」而非「断言失败」，说明现码确实没 fast-fail——正是要修的。实现后变为同步立即 reject。

- [ ] **Step 3: 实现 everConnected + rpcCall 分叉**

`src/web/src/lib/ws-singleton.ts`：

(a) 在状态区（`let started = false;` 之后，约第 38 行）加：
```ts
// 本会话内是否曾成功建立过 WS 连接（onopen 至少触发过一次）。区分「首连 CONNECTING」(false)
// 与「被动掉线重连」(true)——两者 ws 都非 OPEN 但语义相反：首连必须等（保 9ed3042 首屏修复），
// 被动掉线该 fast-fail。单调：onopen 置 true，仅 disconnect/_resetWsSingletonForTest 复位。
let everConnected = false;
```

(b) `sock.onopen`（约 111-115）加置位：
```ts
  sock.onopen = () => {
    everConnected = true;
    setState("connected");
    reconnectDelay = 1000;
    sendSubscriptions();
  };
```

(c) `disconnect()` 里 `started = false;`（约 174）之后加：
```ts
  started = false;
  everConnected = false;
```

(d) `_resetWsSingletonForTest()` 里 `started = false;`（约 283）之后加：
```ts
  started = false;
  everConnected = false;
```

(e) `rpcCall`（约 256-268）改造为：
```ts
export async function rpcCall<T = unknown>(method: string, params?: unknown, opts?: CallOptions): Promise<T> {
  if (restarting) {
    throw new RpcCallError("RESTARTING", "daemon 正在重启，请稍后再试");
  }
  ensureConnected();
  if (ws?.readyState !== WebSocket.OPEN) {
    if (!everConnected) {
      // 首连 CONNECTING：仍等，避免"页面刚打开 → 所有 RPC 一起 reject"的首屏假死（9ed3042）。
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
```

(f) 更新 `rpcCall` 上方的 JSDoc（约 248-255）为三态诚实表述：
```ts
/**
 * 发起 RPC 请求。ws 非 OPEN 时按连接阶段分叉：
 * - restarting（daemon 主动重启窗口，38ec63b）：立即 reject RESTARTING。
 * - 首连 CONNECTING（everConnected=false，页面刚打开）：waitForOpen 最多等 5s，避免首屏假死（9ed3042）。
 * - 被动掉线（everConnected=true，曾连上后 daemon 崩/网抖/睡眠唤醒）：立即 fast-fail DISCONNECTED，
 *   不卡 5s（WEB-08）；DaemonOfflineBanner 另行去抖显红条。
 */
```

- [ ] **Step 4: 跑测试确认全绿**

Run: `bun test tests/ws-singleton-rpc.test.ts`
Expected: INV-1/2/3 全 PASS（INV-2 现在被动掉线同步立即 reject DISCONNECTED）。

- [ ] **Step 5: typecheck + build:web + 全量测试**

Run: `bun run typecheck && bun run build:web && bun test`
Expected: 全绿（typecheck 0 错、build 成功、全量测试含新 3 用例全过）。

- [ ] **Step 6: 提交**
```bash
git add src/web/src/lib/ws-singleton.ts tests/ws-singleton-rpc.test.ts
git commit -m "fix(web): WEB-08 被动断线 rpcCall fast-fail（everConnected 区分首连，保 9ed3042）"
```

---

## 收尾
完成后用 superpowers:finishing-a-development-branch。

**不动（spec §3 核查项，仅确认不受影响）**：`waitForOpen` 本体、`restarting`/Settings 主动重启路径、`DaemonOfflineBanner` 5s 去抖（看 wsState 不看 rpcCall）、`ConnectionState` 类型、`subscribeChannel`（走底层 rpc.call 不经 rpcCall）。

**YAGNI（spec §5，不做）**：断线 RPC 队列重放、backoff 调参、离线模式、被动分支极短宽限窗口、新错误码、TUI/CLI 对等。

## Self-Review
**1. Spec coverage**：everConnected 单调标志（Step 3a/b/c/d）+ rpcCall 三态分叉（Step 3e）+ 注释诚实化（Step 3f）+ INV-1/2/3（Step 1）+ fake WebSocket 注入黑盒（Step 1）。spec §1-3 全覆盖。偏离：两阶段并一个 TDD task（inline 单提交无部署中间态，已说明）。
**2. Placeholder scan**：无 TBD；fake WebSocket + 3 个 INV 测试给完整代码；rpcCall 改造给完整函数体。Step 2 注明 INV-2 可能表现为「卡 5s」而非「断言失败」——这是对现码行为的诚实预判，非占位符。
**3. Type consistency**：`everConnected`（boolean，单调）跨 onopen/disconnect/_reset/rpcCall 一致；`RpcCallError` code `DISCONNECTED`/`RESTARTING` 与现有下游 useApi 归一化契约一致（复用，不发明新码）；fake WebSocket 的静态 `OPEN=1` 与 rpcCall 里 `WebSocket.OPEN` 比较对齐（globalThis.WebSocket 被 fake 覆盖后 `WebSocket.OPEN===1`）。
