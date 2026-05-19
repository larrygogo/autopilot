import { describe, it, expect, beforeEach } from "bun:test";
import { wsManager } from "../src/daemon/ws";
import {
  registerRpcMethod,
  RpcError,
  _resetRpcRegistryForTest,
} from "../src/daemon/rpc";

/**
 * 验证 ws.ts 收到 req frame → 路由到 RPC handler → 回 res frame 的完整 round-trip。
 * 用一个 mock ServerWebSocket，capture send() 调用的字符串验证。
 */

interface SentFrame {
  type: string;
  [k: string]: unknown;
}

function makeMockWs() {
  const sent: SentFrame[] = [];
  const ws = {
    send: (raw: string | Buffer) => {
      const s = typeof raw === "string" ? raw : raw.toString();
      sent.push(JSON.parse(s) as SentFrame);
      return 1;
    },
    // ws.send 在 Bun ServerWebSocket 上还有更多方法，这里只用到 send；
    // wsManager 内部不动其他方法
  } as unknown as Parameters<typeof wsManager.register>[0];
  return { ws, sent };
}

/** 找最近一条 res frame（跳过 register 时发的 connected） */
function findRes(sent: SentFrame[], id: number | string) {
  return sent.find((f) => f.type === "res" && f.id === id);
}

describe("ws RPC dispatch", () => {
  beforeEach(() => {
    _resetRpcRegistryForTest();
  });

  it("req → 成功 handler → res ok:true 含 payload，id 复制", async () => {
    registerRpcMethod({ method: "echo", handler: (p) => ({ got: p }) });

    const { ws, sent } = makeMockWs();
    wsManager.register(ws);
    wsManager.handleMessage(
      ws,
      JSON.stringify({ type: "req", id: 7, method: "echo", params: { x: 1 } }),
    );

    // handler 是异步 promise.then 触发的 send，等一下
    await new Promise((r) => setTimeout(r, 10));

    const res = findRes(sent, 7);
    expect(res).toBeDefined();
    expect(res).toEqual({
      type: "res",
      id: 7,
      ok: true,
      payload: { got: { x: 1 } },
    });

    wsManager.unregister(ws);
  });

  it("未注册 method → res ok:false code:METHOD_NOT_FOUND", async () => {
    const { ws, sent } = makeMockWs();
    wsManager.register(ws);
    wsManager.handleMessage(
      ws,
      JSON.stringify({ type: "req", id: "abc", method: "nope" }),
    );
    await new Promise((r) => setTimeout(r, 10));

    const res = findRes(sent, "abc");
    expect(res).toBeDefined();
    expect(res?.ok).toBe(false);
    expect((res as unknown as { error: { code: string } }).error.code).toBe("METHOD_NOT_FOUND");

    wsManager.unregister(ws);
  });

  it("handler 抛 RpcError → res 透传 code/message", async () => {
    registerRpcMethod({
      method: "badparam",
      handler: () => {
        throw new RpcError("INVALID_PARAM", "需要 id");
      },
    });

    const { ws, sent } = makeMockWs();
    wsManager.register(ws);
    wsManager.handleMessage(
      ws,
      JSON.stringify({ type: "req", id: 99, method: "badparam" }),
    );
    await new Promise((r) => setTimeout(r, 10));

    const res = findRes(sent, 99) as
      | { type: string; id: number; ok: boolean; error: { code: string; message: string } }
      | undefined;
    expect(res?.ok).toBe(false);
    expect(res?.error.code).toBe("INVALID_PARAM");
    // dogfood-bug32: invokeRpcMethod 自动给所有 error message 加 [method] 前缀
    expect(res?.error.message).toBe("[badparam] 需要 id");

    wsManager.unregister(ws);
  });

  it("非 JSON 帧 → 静默丢弃，不崩", () => {
    const { ws, sent } = makeMockWs();
    wsManager.register(ws);
    const before = sent.length;
    // 不会抛
    expect(() => wsManager.handleMessage(ws, "not json {")).not.toThrow();
    expect(sent.length).toBe(before);
    wsManager.unregister(ws);
  });

  it("legacy ping 仍然 → pong（兼容性）", () => {
    const { ws, sent } = makeMockWs();
    wsManager.register(ws);
    wsManager.handleMessage(ws, JSON.stringify({ type: "ping" }));
    const pong = sent.find((f) => f.type === "pong");
    expect(pong).toBeDefined();
    wsManager.unregister(ws);
  });
});
